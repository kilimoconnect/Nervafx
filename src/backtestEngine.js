'use strict';

/**
 * NervaFX Condition Discovery Engine
 *
 * World-class backtesting: instead of replaying hardcoded rules, this engine
 * discovers which market conditions predict price movement by correlating
 * every historical hour's indicators with actual subsequent price action.
 *
 * For each hourly snapshot it captures:
 *   - Market Energy components (movement, momentum, agreement, volatility)
 *   - Energy cycle state (DEAD → EXPLOSIVE)
 *   - Currency strength differentials
 *   - Pair spread levels & states
 *   - M15 impulse patterns
 *   - Session context
 *
 * Then measures what price actually did in the next 1H, 4H, 8H, 12H, 24H.
 * The output: statistical rules with confidence levels for when to trade,
 * when to avoid, expected move distance, and optimal condition thresholds.
 */

const { config }           = require('./config');
const { supabase }         = require('./supabase');
const { calculateAtTime }  = require('./strength');
const { computeSpreads }   = require('./spread');
const { classifyRow }      = require('./stateDetect');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const HORIZONS   = [1, 4, 8, 12, 24]; // hours ahead to measure outcome

// ─── Session classification (mirrors sessionEngine logic) ────────────────────

function classifySession(isoTime) {
  const h = new Date(isoTime).getUTCHours();
  if (h >= 0  && h < 3)  return 'ASIA';
  if (h >= 3  && h < 10) return 'ASIA';
  if (h >= 10 && h < 13) return 'LONDON';
  if (h >= 13 && h < 17) return 'LONDON_NY';
  if (h >= 17 && h < 21) return 'LATE_NY';
  return 'LOW_LIQUIDITY';
}

function isTradingSession(session) {
  return ['ASIA', 'LONDON', 'LONDON_NY', 'LATE_NY'].includes(session);
}

// ─── 1. Load candles ─────────────────────────────────────────────────────────

async function loadCandles(from, to) {
  const lookup = {};       // { inst: { time_iso: close } }
  const candleArrays = {}; // { inst: [{ time, open, high, low, close }] }

  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', instrument)
      .eq('timeframe', 'H1')
      .gte('time', from)
      .lte('time', to)
      .order('time', { ascending: true });

    if (error) throw new Error(`Candle load (${instrument}): ${error.message}`);

    lookup[instrument] = {};
    candleArrays[instrument] = [];

    for (const c of data || []) {
      const t = new Date(c.time).toISOString();
      lookup[instrument][t] = parseFloat(c.close);
      candleArrays[instrument].push({
        time: t,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      });
    }
  }

  return { lookup, candleArrays };
}

// ─── 2. EMA smooth ──────────────────────────────────────────────────────────

function ema(prev, current) {
  if (prev === null || prev === undefined) return current;
  return (prev + current) / 2;
}

// ─── 3. Measure future price action ─────────────────────────────────────────
// For a given pair at time T, measure how far price moved in N hours

function measureOutcome(candleArray, timeIdx, horizonBars) {
  if (timeIdx < 0 || timeIdx + horizonBars >= candleArray.length) return null;

  const entry = candleArray[timeIdx].close;
  let maxUp = 0, maxDown = 0;

  for (let i = 1; i <= horizonBars; i++) {
    const c = candleArray[timeIdx + i];
    maxUp   = Math.max(maxUp, c.high - entry);
    maxDown = Math.max(maxDown, entry - c.low);
  }

  const exitCandle = candleArray[timeIdx + horizonBars];
  const netMove    = exitCandle.close - entry;

  return {
    net_pips:  Math.round(netMove * 10000),
    max_up_pips: Math.round(maxUp * 10000),
    max_down_pips: Math.round(maxDown * 10000),
    direction: netMove > 0 ? 'UP' : netMove < 0 ? 'DOWN' : 'FLAT',
  };
}

// ─── 4. Compute Market Energy components (simplified in-memory) ─────────────
// Mirrors sessionActivity.js Steps 4-9 without DB dependencies

function computeMarketEnergy(candles, sessionOpenPrices) {
  const TOTAL = config.instruments.length;
  const smoothMoveVals = [];
  let alignedActive = 0, totalActive = 0;
  let bullMag = 0, bearMag = 0;
  const normalizedRanges = [];

  // Currency strength from session opens
  const ccyStr = {};
  for (const ccy of CURRENCIES) ccyStr[ccy] = 0;
  let ccyCounts = {};
  for (const ccy of CURRENCIES) ccyCounts[ccy] = 0;

  for (const inst of config.instruments) {
    const [base, quote] = inst.split('_');
    const c = candles[inst];
    const open = sessionOpenPrices[inst];
    if (!c || !open || open === 0) continue;
    const move = (c.close - open) / open;
    ccyStr[base] = (ccyStr[base] || 0) + move;
    ccyCounts[base] = (ccyCounts[base] || 0) + 1;
    ccyStr[quote] = (ccyStr[quote] || 0) - move;
    ccyCounts[quote] = (ccyCounts[quote] || 0) + 1;
  }
  for (const ccy of CURRENCIES) {
    if (ccyCounts[ccy] > 0) ccyStr[ccy] /= ccyCounts[ccy];
  }

  for (const inst of config.instruments) {
    const c = candles[inst];
    const open = sessionOpenPrices[inst];
    if (!c || !open || open === 0) continue;

    const rawDir  = (c.close - open) / open;
    const rawMove = Math.abs(rawDir);
    const normMov = rawMove > 0 ? 1.0 : 0; // simplified norm (no rolling history in backtest)
    smoothMoveVals.push(rawMove * 10000); // in pips-equivalent for readability

    if (rawDir > 0) bullMag += rawMove;
    else if (rawDir < 0) bearMag += rawMove;

    if (rawMove * 10000 >= 5) { // ~5 pip threshold for "active"
      totalActive++;
      const [base, quote] = inst.split('_');
      const expectedDir = (ccyStr[base] || 0) - (ccyStr[quote] || 0);
      if ((expectedDir > 0 && rawDir > 0) || (expectedDir < 0 && rawDir < 0)) alignedActive++;
    }
  }

  const activePairs    = totalActive;
  const movementScore  = Math.round(Math.min(100, (smoothMoveVals.length ? smoothMoveVals.reduce((a,b)=>a+b,0)/smoothMoveVals.length : 0) * 5));
  const breadthScore   = Math.round((activePairs / TOTAL) * 100);
  const rawAgreement   = totalActive > 0 ? alignedActive / totalActive : 0;
  const agreementScore = Math.round(rawAgreement * Math.sqrt(breadthScore / 100) * 100);
  const totalMag       = bullMag + bearMag;
  const bullPressure   = totalMag > 0 ? Math.round(bullMag / totalMag * 100) : 50;
  const bearPressure   = totalMag > 0 ? Math.round(bearMag / totalMag * 100) : 50;

  // Volatility from max range
  const volatilityScore = Math.round(Math.min(100, (smoothMoveVals.length ?
    Math.max(...smoothMoveVals) / 2 : 0)));

  // Market energy composite
  const rawEnergy   = 0.40 * movementScore + 0.30 * breadthScore + 0.20 * agreementScore + 0.10 * volatilityScore;
  const qualityMult = 0.5 + agreementScore / 200;
  const marketEnergy = Math.round(Math.min(100, rawEnergy * qualityMult));

  // Currency ranking
  const sorted = Object.entries(ccyStr).sort((a, b) => b[1] - a[1]);
  const strongest = sorted[0]?.[0] || '';
  const weakest   = sorted[sorted.length - 1]?.[0] || '';
  const strengthDiff = sorted.length >= 2 ? Math.round((sorted[0][1] - sorted[sorted.length-1][1]) * 100000) / 100000 : 0;

  return {
    movement: movementScore,
    momentum: breadthScore, // breadth as momentum proxy
    agreement: agreementScore,
    volatility: volatilityScore,
    market_energy: marketEnergy,
    active_pairs: activePairs,
    bull_pressure: bullPressure,
    bear_pressure: bearPressure,
    strongest,
    weakest,
    strength_diff: strengthDiff,
  };
}

// ─── 5. Main analysis engine ─────────────────────────────────────────────────

async function runBacktest({ from, to }) {
  const startTime = Date.now();

  console.log(`[BACKTEST] Loading candles ${from} → ${to}...`);
  const { lookup, candleArrays } = await loadCandles(from, to);

  // Build time index per instrument
  const timeIndex = {};
  for (const inst of config.instruments) {
    timeIndex[inst] = {};
    (candleArrays[inst] || []).forEach((c, i) => { timeIndex[inst][c.time] = i; });
  }

  // Collect all timestamps
  const allTimes = new Set();
  for (const inst of config.instruments) {
    for (const t of Object.keys(lookup[inst] || {})) allTimes.add(t);
  }
  const timestamps = [...allTimes].sort();
  console.log(`[BACKTEST] ${timestamps.length} H1 bars to analyze`);

  // ── Phase 1: Strength + Smooth + Spreads + States ──────────────────────────
  console.log('[BACKTEST] Phase 1: Building strength/spreads/states...');
  const strengthByTime = {};
  const smoothByTime   = {};
  const prevSmooth     = {};
  const spreadsByInst  = {};
  const statesByInst   = {};

  for (const time of timestamps) {
    const rows = calculateAtTime(lookup, time);
    if (!rows) continue;

    strengthByTime[time] = {};
    for (const r of rows) {
      strengthByTime[time][r.currency] = { n3h: r.normalized_3h, n6h: r.normalized_6h, n12h: r.normalized_12h };
    }

    // Smooth
    smoothByTime[time] = {};
    for (const currency of CURRENCIES) {
      const raw = strengthByTime[time][currency];
      if (!raw) continue;
      const prev = prevSmooth[currency] || {};
      const s3h  = ema(prev.s3h, raw.n3h);
      const s6h  = ema(prev.s6h, raw.n6h);
      const s12h = ema(prev.s12h, raw.n12h);
      smoothByTime[time][currency] = { s3h, s6h, s12h };
      prevSmooth[currency] = { s3h, s6h, s12h };
    }

    // Spreads
    if (Object.keys(smoothByTime[time]).length === 8) {
      const spreads = computeSpreads(time, smoothByTime[time]);
      if (spreads) {
        for (const r of spreads) {
          if (!spreadsByInst[r.instrument]) spreadsByInst[r.instrument] = [];
          spreadsByInst[r.instrument].push(r);
        }
      }
    }
  }

  // States
  for (const inst of config.instruments) {
    const spreads = spreadsByInst[inst] || [];
    statesByInst[inst] = {};
    let prevSpread = null, prevState = null;
    for (const spread of spreads) {
      const result = classifyRow(spread, prevSpread, prevState);
      statesByInst[inst][spread.time] = result;
      prevSpread = spread;
      prevState = result.state;
    }
  }

  // ── Phase 2: Build hourly snapshots with Market Energy + outcomes ──────────
  console.log('[BACKTEST] Phase 2: Building condition snapshots + measuring outcomes...');

  let currentSession = null;
  let sessionOpenPrices = {};
  const snapshots = []; // Each = one hour's conditions + what happened next

  for (const time of timestamps) {
    const session = classifySession(time);
    if (!isTradingSession(session)) continue;

    // Session transition — reset open prices
    if (session !== currentSession) {
      sessionOpenPrices = {};
      for (const inst of config.instruments) {
        const c = lookup[inst]?.[time];
        if (c != null) sessionOpenPrices[inst] = c;
      }
      currentSession = session;
    }

    // Build candle snapshot for this hour
    const candleSnap = {};
    for (const inst of config.instruments) {
      const idx = timeIndex[inst]?.[time];
      if (idx != null) candleSnap[inst] = candleArrays[inst][idx];
    }
    if (Object.keys(candleSnap).length < 20) continue; // need most instruments

    // Market Energy
    const energy = computeMarketEnergy(candleSnap, sessionOpenPrices);

    // Pair-level state summary at this hour
    let trendCount = 0, pullbackCount = 0, readyCount = 0, noTradeCount = 0, reversalCount = 0;
    let avgConfidence = 0, maxSpread = 0;

    for (const inst of config.instruments) {
      const state = statesByInst[inst]?.[time];
      if (!state) continue;
      if (state.state === 'TREND') trendCount++;
      else if (state.state === 'PULLBACK_ACTIVE' || state.state === 'PULLBACK_STARTING' || state.state === 'BASE_FORMING') pullbackCount++;
      else if (state.state === 'READY_TO_ENTER') readyCount++;
      else if (state.state === 'NO_TRADE') noTradeCount++;
      else if (state.state?.includes('REVERSAL')) reversalCount++;
      avgConfidence += state.confidence || 0;
      maxSpread = Math.max(maxSpread, Math.abs(state.spread_6h || 0));
    }
    avgConfidence = config.instruments.length > 0 ? Math.round(avgConfidence / config.instruments.length) : 0;

    // Measure outcomes for TOP spread pairs (strongest setups)
    const pairOutcomes = [];
    for (const inst of config.instruments) {
      const state = statesByInst[inst]?.[time];
      const idx   = timeIndex[inst]?.[time];
      if (!state || idx == null) continue;

      const outcomes = {};
      for (const h of HORIZONS) {
        outcomes[`h${h}`] = measureOutcome(candleArrays[inst], idx, h);
      }

      const absSpread6h = Math.abs(state.spread_6h || 0);
      if (absSpread6h >= 0.001) { // only measure meaningful spreads
        pairOutcomes.push({
          instrument: inst,
          bias: state.bias,
          state: state.state,
          confidence: state.confidence,
          spread_6h: state.spread_6h,
          spread_12h: state.spread_12h,
          ...outcomes,
        });
      }
    }

    snapshots.push({
      time,
      session,
      energy,
      states: { trend: trendCount, pullback: pullbackCount, ready: readyCount, noTrade: noTradeCount, reversal: reversalCount },
      avg_confidence: avgConfidence,
      max_spread: Math.round(maxSpread * 100000) / 100000,
      pair_outcomes: pairOutcomes,
    });
  }

  console.log(`[BACKTEST] ${snapshots.length} hourly snapshots built`);

  // ── Phase 3: Statistical analysis — discover conditions ────────────────────
  console.log('[BACKTEST] Phase 3: Discovering condition thresholds...');

  const analysis = {
    component_thresholds: analyzeComponentThresholds(snapshots),
    conditional_edge: analyzeConditionalEdge(snapshots),
    heatmaps: analyzeHeatmaps(snapshots),
    regime_thresholds: analyzeRegimeThresholds(snapshots),
    session_thresholds: analyzeSessionThresholds(snapshots),
    transitions: analyzeTransitions(snapshots),
    edge_stability: analyzeEdgeStability(snapshots),
    probability_curves: analyzeProbabilityCurves(snapshots),
    energy_thresholds: analyzeEnergyThresholds(snapshots),
    strength_thresholds: analyzeStrengthThresholds(snapshots),
    session_performance: analyzeSessionPerformance(snapshots),
    state_outcomes: analyzeStateOutcomes(snapshots),
    no_trade_zones: analyzeNoTradeZones(snapshots),
    condition_combos: analyzeConditionCombos(snapshots),
    move_distance: analyzeMoveDistance(snapshots),
  };

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[BACKTEST] Analysis complete in ${elapsed}s`);

  return {
    config: { from, to },
    duration_sec: parseFloat(elapsed),
    snapshots_analyzed: snapshots.length,
    analysis,
  };
}

// ─── Analysis modules ────────────────────────────────────────────────────────

// ── Master component threshold analyzer ─────────────────────────────────────
// Analyzes EVERY measurable component individually: buckets values, measures
// outcomes at each level, and finds optimal thresholds, sweet spots & danger zones.

function analyzeComponentThresholds(snapshots) {
  // Define every component to analyze with its extraction function and bucketing
  const components = [
    {
      id: 'movement', name: 'Movement Score', group: 'Market Energy',
      desc: 'How much price is moving across all pairs (0–100)',
      extract: s => s.energy.movement,
      ranges: [[0,15],[15,30],[30,45],[45,60],[60,80],[80,100]],
      unit: '',
    },
    {
      id: 'momentum', name: 'Momentum (Breadth)', group: 'Market Energy',
      desc: 'Percentage of pairs actively moving — market participation width (0–100)',
      extract: s => s.energy.momentum,
      ranges: [[0,15],[15,30],[30,45],[45,60],[60,80],[80,100]],
      unit: '%',
    },
    {
      id: 'agreement', name: 'Agreement Score', group: 'Market Energy',
      desc: 'How aligned active pairs are with currency strength direction (0–100)',
      extract: s => s.energy.agreement,
      ranges: [[0,15],[15,30],[30,45],[45,60],[60,80],[80,100]],
      unit: '',
    },
    {
      id: 'volatility', name: 'Volatility Score', group: 'Market Energy',
      desc: 'Raw range intensity — how wide candles are printing (0–100)',
      extract: s => s.energy.volatility,
      ranges: [[0,15],[15,30],[30,45],[45,60],[60,80],[80,100]],
      unit: '',
    },
    {
      id: 'market_energy', name: 'Market Energy (Composite)', group: 'Market Energy',
      desc: 'Weighted blend of movement, breadth, agreement & volatility (0–100)',
      extract: s => s.energy.market_energy,
      ranges: [[0,10],[10,20],[20,30],[30,45],[45,60],[60,80],[80,100]],
      unit: '',
    },
    {
      id: 'bull_pressure', name: 'Bull Pressure', group: 'Directional Pressure',
      desc: 'Proportion of total magnitude coming from bullish pairs (0–100%)',
      extract: s => s.energy.bull_pressure,
      ranges: [[0,20],[20,35],[35,50],[50,65],[65,80],[80,100]],
      unit: '%',
    },
    {
      id: 'bear_pressure', name: 'Bear Pressure', group: 'Directional Pressure',
      desc: 'Proportion of total magnitude coming from bearish pairs (0–100%)',
      extract: s => s.energy.bear_pressure,
      ranges: [[0,20],[20,35],[35,50],[50,65],[65,80],[80,100]],
      unit: '%',
    },
    {
      id: 'dominance', name: 'Directional Dominance', group: 'Directional Pressure',
      desc: 'Imbalance between bull and bear pressure — higher = one side controls the market',
      extract: s => Math.abs(s.energy.bull_pressure - s.energy.bear_pressure),
      ranges: [[0,10],[10,20],[20,30],[30,45],[45,60],[60,100]],
      unit: '',
    },
    {
      id: 'active_pairs', name: 'Liquidity (Active Pairs)', group: 'Market Structure',
      desc: 'Number of pairs moving ≥5 pips — measures how many pairs are "alive" (0–28)',
      extract: s => s.energy.active_pairs,
      ranges: [[0,3],[3,6],[6,10],[10,15],[15,20],[20,28]],
      unit: '',
    },
    {
      id: 'strength_diff', name: 'Currency Strength Differential', group: 'Currency Strength',
      desc: 'Gap between strongest and weakest currency — the raw fuel for directional moves',
      extract: s => s.energy.strength_diff,
      ranges: [[0,0.0005],[0.0005,0.001],[0.001,0.002],[0.002,0.003],[0.003,0.005],[0.005,Infinity]],
      unit: '',
      formatRange: (lo, hi) => hi === Infinity ? `${lo}+` : `${lo}–${hi}`,
    },
    {
      id: 'ready_count', name: 'Readiness (Ready-to-Enter Pairs)', group: 'Market Structure',
      desc: 'How many pairs have completed pullback and are ready for entry (0–28)',
      extract: s => s.states.ready,
      ranges: [[0,1],[1,2],[2,4],[4,6],[6,10],[10,28]],
      unit: '',
    },
    {
      id: 'trend_count', name: 'Trending Pairs', group: 'Market Structure',
      desc: 'Number of pairs in active trend state — measures market conviction',
      extract: s => s.states.trend,
      ranges: [[0,3],[3,6],[6,10],[10,14],[14,20],[20,28]],
      unit: '',
    },
    {
      id: 'pullback_count', name: 'Pullback Pairs', group: 'Market Structure',
      desc: 'Pairs currently pulling back — future entry candidates forming',
      extract: s => s.states.pullback,
      ranges: [[0,2],[2,4],[4,7],[7,10],[10,15],[15,28]],
      unit: '',
    },
    {
      id: 'reversal_count', name: 'Reversal Pairs', group: 'Market Structure',
      desc: 'Pairs showing reversal signals — structural uncertainty indicator',
      extract: s => s.states.reversal,
      ranges: [[0,2],[2,4],[4,7],[7,10],[10,15],[15,28]],
      unit: '',
    },
    {
      id: 'avg_confidence', name: 'Average Confidence', group: 'Quality Metrics',
      desc: 'Mean confidence score across all pair states — overall signal quality',
      extract: s => s.avg_confidence,
      ranges: [[0,30],[30,45],[45,55],[55,65],[65,80],[80,100]],
      unit: '',
    },
    {
      id: 'max_spread', name: 'Max Pair Spread (6H)', group: 'Currency Strength',
      desc: 'Largest 6H spread among all pairs — indicates strongest individual setup',
      extract: s => s.max_spread,
      ranges: [[0,0.001],[0.001,0.002],[0.002,0.003],[0.003,0.005],[0.005,0.008],[0.008,Infinity]],
      unit: '',
      formatRange: (lo, hi) => hi === Infinity ? `${lo}+` : `${lo}–${hi}`,
    },
  ];

  const results = [];

  for (const comp of components) {
    const buckets = {};

    for (const snap of snapshots) {
      const val = comp.extract(snap);
      if (val == null || isNaN(val)) continue;

      // Find matching range
      for (const [lo, hi] of comp.ranges) {
        if (val >= lo && val < hi) {
          const label = comp.formatRange ? comp.formatRange(lo, hi) : `${lo}–${hi}`;
          if (!buckets[label]) buckets[label] = { lo, hi, hours: 0, outcomes: [], moves: [] };
          buckets[label].hours++;

          // Collect pair outcomes for this hour
          for (const po of snap.pair_outcomes) {
            if (!po.h4) continue;
            const dirCorrect = (po.bias === 'BUY' && po.h4.net_pips > 0) || (po.bias === 'SELL' && po.h4.net_pips < 0);
            const favourable = po.bias === 'BUY' ? po.h4.max_up_pips : po.h4.max_down_pips;
            const adverse    = po.bias === 'BUY' ? po.h4.max_down_pips : po.h4.max_up_pips;
            buckets[label].outcomes.push({ correct: dirCorrect, net: po.h4.net_pips, favourable, adverse });
            buckets[label].moves.push(Math.max(po.h4.max_up_pips, po.h4.max_down_pips));
          }
          break;
        }
      }
    }

    // Compute stats per bucket
    const rangeStats = {};
    let bestRange = null, bestWR = 0, worstRange = null, worstWR = 100;
    let bestMoveRange = null, bestMove = 0;

    for (const [label, b] of Object.entries(buckets)) {
      if (b.outcomes.length < 10) {
        rangeStats[label] = { hours: b.hours, trades: b.outcomes.length, win_rate: null, avg_move: null, avg_fav: null, avg_adv: null, avg_net: null, insufficient: true };
        continue;
      }

      const wins = b.outcomes.filter(o => o.correct).length;
      const wr   = Math.round(wins / b.outcomes.length * 100);
      const avgMove = Math.round(b.moves.reduce((s, m) => s + m, 0) / b.moves.length);
      const avgFav  = Math.round(b.outcomes.reduce((s, o) => s + o.favourable, 0) / b.outcomes.length);
      const avgAdv  = Math.round(b.outcomes.reduce((s, o) => s + o.adverse, 0) / b.outcomes.length);
      const avgNet  = Math.round(b.outcomes.reduce((s, o) => s + o.net, 0) / b.outcomes.length);

      rangeStats[label] = { hours: b.hours, trades: b.outcomes.length, win_rate: wr, avg_move: avgMove, avg_fav: avgFav, avg_adv: avgAdv, avg_net: avgNet, insufficient: false };

      if (wr > bestWR)  { bestWR = wr;  bestRange = label; }
      if (wr < worstWR) { worstWR = wr; worstRange = label; }
      if (avgMove > bestMove) { bestMove = avgMove; bestMoveRange = label; }
    }

    // Find minimum threshold for >50% edge
    let minEdgeThreshold = null;
    const sortedLabels = Object.keys(rangeStats).sort((a, b) => {
      const aLo = buckets[a]?.lo ?? 0;
      const bLo = buckets[b]?.lo ?? 0;
      return aLo - bLo;
    });
    for (const label of sortedLabels) {
      const s = rangeStats[label];
      if (!s.insufficient && s.win_rate >= 52) {
        minEdgeThreshold = label;
        break;
      }
    }

    results.push({
      id: comp.id,
      name: comp.name,
      group: comp.group,
      description: comp.desc,
      unit: comp.unit,
      ranges: rangeStats,
      best_range: bestRange,
      best_win_rate: bestWR,
      worst_range: worstRange,
      worst_win_rate: worstWR,
      best_move_range: bestMoveRange,
      best_avg_move: bestMove,
      min_edge_threshold: minEdgeThreshold,
    });
  }

  return results;
}

function analyzeEnergyThresholds(snapshots) {
  // Bucket by movement score ranges and measure outcome quality
  const buckets = { '0-20': [], '20-40': [], '40-60': [], '60-80': [], '80-100': [] };

  for (const snap of snapshots) {
    const m = snap.energy.movement;
    const key = m < 20 ? '0-20' : m < 40 ? '20-40' : m < 60 ? '40-60' : m < 80 ? '60-80' : '80-100';
    for (const po of snap.pair_outcomes) {
      if (po.h4) buckets[key].push(po.h4);
    }
  }

  const result = {};
  for (const [range, outcomes] of Object.entries(buckets)) {
    if (!outcomes.length) continue;
    const wins = outcomes.filter(o => Math.abs(o.net_pips) >= 10 && ((o.direction === 'UP' && o.net_pips > 0) || (o.direction === 'DOWN' && o.net_pips < 0)));
    result[range] = {
      samples: outcomes.length,
      avg_net_pips: Math.round(outcomes.reduce((s, o) => s + Math.abs(o.net_pips), 0) / outcomes.length),
      avg_max_move: Math.round(outcomes.reduce((s, o) => s + Math.max(o.max_up_pips, o.max_down_pips), 0) / outcomes.length),
      directional_rate: Math.round(outcomes.filter(o => Math.abs(o.net_pips) >= 10).length / outcomes.length * 100),
    };
  }

  // Same for agreement, momentum (breadth), volatility
  const componentAnalysis = {};
  for (const comp of ['movement', 'momentum', 'agreement', 'volatility', 'market_energy']) {
    componentAnalysis[comp] = {};
    const ranges = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100]];
    for (const [lo, hi] of ranges) {
      const matching = snapshots.filter(s => s.energy[comp] >= lo && s.energy[comp] < hi);
      const outcomes = matching.flatMap(s => s.pair_outcomes.filter(p => p.h4).map(p => p.h4));
      if (!outcomes.length) continue;
      componentAnalysis[comp][`${lo}-${hi}`] = {
        hours: matching.length,
        pairs_measured: outcomes.length,
        avg_move_pips: Math.round(outcomes.reduce((s, o) => s + Math.max(o.max_up_pips, o.max_down_pips), 0) / outcomes.length),
        avg_net_pips: Math.round(outcomes.reduce((s, o) => s + o.net_pips, 0) / outcomes.length),
        continuation_rate: Math.round(outcomes.filter(o => {
          return Math.abs(o.net_pips) >= 8;
        }).length / outcomes.length * 100),
      };
    }
  }

  return { movement_buckets: result, by_component: componentAnalysis };
}

function analyzeStrengthThresholds(snapshots) {
  // Group by currency strength differential and measure continuation
  const diffBuckets = {};
  const ranges = [[0, 0.001], [0.001, 0.002], [0.002, 0.003], [0.003, 0.005], [0.005, 0.01], [0.01, Infinity]];

  for (const snap of snapshots) {
    for (const po of snap.pair_outcomes) {
      if (!po.h8) continue;
      const diff = Math.abs(po.spread_6h || 0);
      for (const [lo, hi] of ranges) {
        if (diff >= lo && diff < hi) {
          const key = hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
          if (!diffBuckets[key]) diffBuckets[key] = [];
          diffBuckets[key].push({
            bias: po.bias,
            net: po.h8.net_pips,
            maxFav: po.bias === 'BUY' ? po.h8.max_up_pips : po.h8.max_down_pips,
            maxAdv: po.bias === 'BUY' ? po.h8.max_down_pips : po.h8.max_up_pips,
          });
          break;
        }
      }
    }
  }

  const result = {};
  for (const [key, items] of Object.entries(diffBuckets)) {
    if (!items.length) continue;
    const correctDir = items.filter(i => {
      return (i.bias === 'BUY' && i.net > 0) || (i.bias === 'SELL' && i.net < 0);
    });
    result[key] = {
      samples: items.length,
      continuation_rate: Math.round(correctDir.length / items.length * 100),
      avg_favourable_pips: Math.round(items.reduce((s, i) => s + i.maxFav, 0) / items.length),
      avg_adverse_pips: Math.round(items.reduce((s, i) => s + i.maxAdv, 0) / items.length),
      avg_net_pips: Math.round(items.reduce((s, i) => s + Math.abs(i.net), 0) / items.length),
    };
  }

  return result;
}

function analyzeSessionPerformance(snapshots) {
  const sessions = {};

  for (const snap of snapshots) {
    const s = snap.session;
    if (!sessions[s]) sessions[s] = { hours: 0, outcomes_4h: [], outcomes_8h: [], energy: [] };
    sessions[s].hours++;
    sessions[s].energy.push(snap.energy.market_energy);

    for (const po of snap.pair_outcomes) {
      if (po.h4) sessions[s].outcomes_4h.push(po.h4);
      if (po.h8) sessions[s].outcomes_8h.push(po.h8);
    }
  }

  const result = {};
  for (const [s, data] of Object.entries(sessions)) {
    const o4 = data.outcomes_4h;
    const o8 = data.outcomes_8h;
    result[s] = {
      hours: data.hours,
      avg_energy: data.energy.length ? Math.round(data.energy.reduce((a,b)=>a+b,0) / data.energy.length) : 0,
      h4_avg_move: o4.length ? Math.round(o4.reduce((s, o) => s + Math.max(o.max_up_pips, o.max_down_pips), 0) / o4.length) : 0,
      h4_samples: o4.length,
      h8_avg_move: o8.length ? Math.round(o8.reduce((s, o) => s + Math.max(o.max_up_pips, o.max_down_pips), 0) / o8.length) : 0,
      h8_samples: o8.length,
    };
  }

  return result;
}

function analyzeStateOutcomes(snapshots) {
  const stateResults = {};

  for (const snap of snapshots) {
    for (const po of snap.pair_outcomes) {
      if (!po.h4 || !po.state) continue;
      if (!stateResults[po.state]) stateResults[po.state] = [];

      const dirCorrect = (po.bias === 'BUY' && po.h4.net_pips > 0) || (po.bias === 'SELL' && po.h4.net_pips < 0);
      stateResults[po.state].push({
        correct: dirCorrect,
        net: po.h4.net_pips,
        maxFav: po.bias === 'BUY' ? po.h4.max_up_pips : po.h4.max_down_pips,
        maxAdv: po.bias === 'BUY' ? po.h4.max_down_pips : po.h4.max_up_pips,
        confidence: po.confidence,
      });
    }
  }

  const result = {};
  for (const [state, items] of Object.entries(stateResults)) {
    const correct = items.filter(i => i.correct);
    result[state] = {
      samples: items.length,
      win_rate: Math.round(correct.length / items.length * 100),
      avg_favourable: Math.round(items.reduce((s, i) => s + i.maxFav, 0) / items.length),
      avg_adverse: Math.round(items.reduce((s, i) => s + i.maxAdv, 0) / items.length),
      avg_confidence: Math.round(items.reduce((s, i) => s + i.confidence, 0) / items.length),
    };
  }

  return result;
}

function analyzeNoTradeZones(snapshots) {
  // Find conditions where directional accuracy drops below 45%
  const zones = [];

  // Low energy + low agreement
  const lowEnergyLowAgr = snapshots.filter(s => s.energy.market_energy < 20 && s.energy.agreement < 25);
  const lelaOutcomes = lowEnergyLowAgr.flatMap(s => s.pair_outcomes.filter(p => p.h4).map(p => ({
    correct: (p.bias === 'BUY' && p.h4.net_pips > 0) || (p.bias === 'SELL' && p.h4.net_pips < 0),
    net: p.h4.net_pips,
  })));
  if (lelaOutcomes.length >= 10) {
    const wr = Math.round(lelaOutcomes.filter(o => o.correct).length / lelaOutcomes.length * 100);
    zones.push({
      condition: 'Low Energy (<20) + Low Agreement (<25)',
      samples: lelaOutcomes.length,
      win_rate: wr,
      avg_pips: Math.round(lelaOutcomes.reduce((s, o) => s + o.net, 0) / lelaOutcomes.length),
      verdict: wr < 45 ? 'AVOID' : 'CAUTION',
    });
  }

  // Low active pairs
  const lowActive = snapshots.filter(s => s.energy.active_pairs < 5);
  const laOutcomes = lowActive.flatMap(s => s.pair_outcomes.filter(p => p.h4).map(p => ({
    correct: (p.bias === 'BUY' && p.h4.net_pips > 0) || (p.bias === 'SELL' && p.h4.net_pips < 0),
    net: p.h4.net_pips,
  })));
  if (laOutcomes.length >= 10) {
    const wr = Math.round(laOutcomes.filter(o => o.correct).length / laOutcomes.length * 100);
    zones.push({
      condition: 'Active Pairs < 5 (thin market)',
      samples: laOutcomes.length,
      win_rate: wr,
      avg_pips: Math.round(laOutcomes.reduce((s, o) => s + o.net, 0) / laOutcomes.length),
      verdict: wr < 45 ? 'AVOID' : 'CAUTION',
    });
  }

  // High volatility + low agreement (choppy)
  const chop = snapshots.filter(s => s.energy.volatility > 60 && s.energy.agreement < 30);
  const chopOutcomes = chop.flatMap(s => s.pair_outcomes.filter(p => p.h4).map(p => ({
    correct: (p.bias === 'BUY' && p.h4.net_pips > 0) || (p.bias === 'SELL' && p.h4.net_pips < 0),
    net: p.h4.net_pips,
  })));
  if (chopOutcomes.length >= 10) {
    const wr = Math.round(chopOutcomes.filter(o => o.correct).length / chopOutcomes.length * 100);
    zones.push({
      condition: 'High Volatility (>60) + Low Agreement (<30) — choppy',
      samples: chopOutcomes.length,
      win_rate: wr,
      avg_pips: Math.round(chopOutcomes.reduce((s, o) => s + o.net, 0) / chopOutcomes.length),
      verdict: wr < 45 ? 'AVOID' : 'CAUTION',
    });
  }

  // Low movement + high reversal count
  const revHeavy = snapshots.filter(s => s.states.reversal >= 8 && s.energy.movement < 30);
  const revOutcomes = revHeavy.flatMap(s => s.pair_outcomes.filter(p => p.h4).map(p => ({
    correct: (p.bias === 'BUY' && p.h4.net_pips > 0) || (p.bias === 'SELL' && p.h4.net_pips < 0),
    net: p.h4.net_pips,
  })));
  if (revOutcomes.length >= 10) {
    const wr = Math.round(revOutcomes.filter(o => o.correct).length / revOutcomes.length * 100);
    zones.push({
      condition: 'Many Reversals (8+) + Low Movement (<30)',
      samples: revOutcomes.length,
      win_rate: wr,
      avg_pips: Math.round(revOutcomes.reduce((s, o) => s + o.net, 0) / revOutcomes.length),
      verdict: wr < 45 ? 'AVOID' : 'CAUTION',
    });
  }

  // Bear/bull pressure imbalance with low energy
  const imbalance = snapshots.filter(s =>
    (s.energy.bull_pressure > 75 || s.energy.bear_pressure > 75) && s.energy.market_energy < 25
  );
  const imbOutcomes = imbalance.flatMap(s => s.pair_outcomes.filter(p => p.h4).map(p => ({
    correct: (p.bias === 'BUY' && p.h4.net_pips > 0) || (p.bias === 'SELL' && p.h4.net_pips < 0),
    net: p.h4.net_pips,
  })));
  if (imbOutcomes.length >= 10) {
    const wr = Math.round(imbOutcomes.filter(o => o.correct).length / imbOutcomes.length * 100);
    zones.push({
      condition: 'Strong Pressure Imbalance (>75%) + Low Energy (<25)',
      samples: imbOutcomes.length,
      win_rate: wr,
      avg_pips: Math.round(imbOutcomes.reduce((s, o) => s + o.net, 0) / imbOutcomes.length),
      verdict: wr < 45 ? 'AVOID' : 'CAUTION',
    });
  }

  return zones;
}

function analyzeConditionCombos(snapshots) {
  // Find the BEST condition combinations
  const combos = [];

  // High energy + high agreement + READY_TO_ENTER states
  const ideal = snapshots.filter(s =>
    s.energy.market_energy >= 40 && s.energy.agreement >= 40 && s.states.ready >= 1
  );
  const idealOutcomes = ideal.flatMap(s => s.pair_outcomes
    .filter(p => p.h8 && p.state === 'READY_TO_ENTER')
    .map(p => ({
      correct: (p.bias === 'BUY' && p.h8.net_pips > 0) || (p.bias === 'SELL' && p.h8.net_pips < 0),
      net: p.h8.net_pips,
      maxFav: p.bias === 'BUY' ? p.h8.max_up_pips : p.h8.max_down_pips,
    }))
  );
  if (idealOutcomes.length >= 5) {
    combos.push({
      name: 'High Energy + High Agreement + Ready-to-Enter',
      condition: 'Energy ≥40, Agreement ≥40, state=READY_TO_ENTER',
      samples: idealOutcomes.length,
      win_rate: Math.round(idealOutcomes.filter(o => o.correct).length / idealOutcomes.length * 100),
      avg_move: Math.round(idealOutcomes.reduce((s, o) => s + o.maxFav, 0) / idealOutcomes.length),
      verdict: 'STRONG_ENTRY',
    });
  }

  // Trend + strong spread + high movement
  const trendStrong = snapshots.filter(s =>
    s.energy.movement >= 45 && s.max_spread >= 0.003 && s.states.trend >= 5
  );
  const tsOutcomes = trendStrong.flatMap(s => s.pair_outcomes
    .filter(p => p.h4 && (p.state === 'TREND' || p.state === 'READY_TO_ENTER'))
    .map(p => ({
      correct: (p.bias === 'BUY' && p.h4.net_pips > 0) || (p.bias === 'SELL' && p.h4.net_pips < 0),
      maxFav: p.bias === 'BUY' ? p.h4.max_up_pips : p.h4.max_down_pips,
    }))
  );
  if (tsOutcomes.length >= 5) {
    combos.push({
      name: 'Strong Trend Environment',
      condition: 'Movement ≥45, Spread ≥0.003, 5+ pairs trending',
      samples: tsOutcomes.length,
      win_rate: Math.round(tsOutcomes.filter(o => o.correct).length / tsOutcomes.length * 100),
      avg_move: Math.round(tsOutcomes.reduce((s, o) => s + o.maxFav, 0) / tsOutcomes.length),
      verdict: 'STRONG_ENTRY',
    });
  }

  // Compression breakout (low energy → rising)
  const compression = snapshots.filter((s, i) => {
    if (i < 3) return false;
    const prev = snapshots[i - 1];
    return prev.energy.market_energy < 20 && s.energy.market_energy >= 25 && s.energy.movement > prev.energy.movement;
  });
  const compOutcomes = compression.flatMap(s => s.pair_outcomes
    .filter(p => p.h8 && Math.abs(p.spread_6h) >= 0.002)
    .map(p => ({
      correct: (p.bias === 'BUY' && p.h8.net_pips > 0) || (p.bias === 'SELL' && p.h8.net_pips < 0),
      maxFav: p.bias === 'BUY' ? p.h8.max_up_pips : p.h8.max_down_pips,
    }))
  );
  if (compOutcomes.length >= 5) {
    combos.push({
      name: 'Compression Breakout',
      condition: 'Energy rising from <20, Movement increasing, Spread ≥0.002',
      samples: compOutcomes.length,
      win_rate: Math.round(compOutcomes.filter(o => o.correct).length / compOutcomes.length * 100),
      avg_move: Math.round(compOutcomes.reduce((s, o) => s + o.maxFav, 0) / compOutcomes.length),
      verdict: 'OPPORTUNITY',
    });
  }

  return combos;
}

function analyzeMoveDistance(snapshots) {
  // Expected pip distance at different time horizons
  const byHorizon = {};

  for (const h of HORIZONS) {
    const key = `h${h}`;
    const all = snapshots.flatMap(s =>
      s.pair_outcomes.filter(p => p[key]).map(p => ({
        maxMove: Math.max(p[key].max_up_pips, p[key].max_down_pips),
        netMove: Math.abs(p[key].net_pips),
        energy: s.energy.market_energy,
      }))
    );

    if (!all.length) continue;

    // Split by energy level
    const lowE  = all.filter(a => a.energy < 30);
    const midE  = all.filter(a => a.energy >= 30 && a.energy < 60);
    const highE = all.filter(a => a.energy >= 60);

    const avg = (arr, fn) => arr.length ? Math.round(arr.reduce((s, a) => s + fn(a), 0) / arr.length) : 0;

    byHorizon[key] = {
      horizon_hours: h,
      total_samples: all.length,
      overall_avg_max: avg(all, a => a.maxMove),
      overall_avg_net: avg(all, a => a.netMove),
      low_energy:  { samples: lowE.length,  avg_max: avg(lowE, a => a.maxMove),  avg_net: avg(lowE, a => a.netMove) },
      mid_energy:  { samples: midE.length,  avg_max: avg(midE, a => a.maxMove),  avg_net: avg(midE, a => a.netMove) },
      high_energy: { samples: highE.length, avg_max: avg(highE, a => a.maxMove), avg_net: avg(highE, a => a.netMove) },
    };
  }

  return byHorizon;
}

// ─── Advanced Analysis: Conditional Discovery Engine ─────────────────────────
// Multi-factor stacking — discovers how conditions compound edge

function _flattenOutcomes(snapshots, horizon = 'h4') {
  const rows = [];
  for (const snap of snapshots) {
    for (const po of snap.pair_outcomes) {
      if (!po[horizon]) continue;
      const correct = (po.bias === 'BUY' && po[horizon].net_pips > 0) || (po.bias === 'SELL' && po[horizon].net_pips < 0);
      const fav = po.bias === 'BUY' ? po[horizon].max_up_pips : po[horizon].max_down_pips;
      const adv = po.bias === 'BUY' ? po[horizon].max_down_pips : po[horizon].max_up_pips;
      rows.push({
        correct, net: po[horizon].net_pips, fav, adv,
        energy: snap.energy.market_energy, movement: snap.energy.movement,
        momentum: snap.energy.momentum, agreement: snap.energy.agreement,
        volatility: snap.energy.volatility, bull_pressure: snap.energy.bull_pressure,
        bear_pressure: snap.energy.bear_pressure, active_pairs: snap.energy.active_pairs,
        strength_diff: snap.energy.strength_diff,
        dominance: Math.abs(snap.energy.bull_pressure - snap.energy.bear_pressure),
        session: snap.session, time: snap.time,
        state: po.state, confidence: po.confidence,
        spread_6h: Math.abs(po.spread_6h || 0),
        ready: snap.states.ready, trend: snap.states.trend,
        pullback: snap.states.pullback, reversal: snap.states.reversal,
      });
    }
  }
  return rows;
}

function _measurePool(pool) {
  if (!pool.length) return null;
  const wins = pool.filter(r => r.correct).length;
  return {
    samples: pool.length,
    win_rate: Math.round(wins / pool.length * 100),
    avg_fav: Math.round(pool.reduce((s, r) => s + r.fav, 0) / pool.length),
    avg_adv: Math.round(pool.reduce((s, r) => s + r.adv, 0) / pool.length),
    avg_net: Math.round(pool.reduce((s, r) => s + r.net, 0) / pool.length),
  };
}

function analyzeConditionalEdge(snapshots) {
  const all = _flattenOutcomes(snapshots, 'h4');
  if (all.length < 50) return { chains: [] };

  const baseline = _measurePool(all);

  // Build progressive filter chains — each step adds one condition
  const chains = [];

  // ── Chain 1: The Complete Edge Stack (CS-based)
  const c1 = [{ label: 'All trades (baseline)', pool: all }];
  let pool = all;
  const filters1 = [
    { label: '+ CS Diff > 0.002', fn: r => r.spread_6h > 0.002 },
    { label: '+ Energy > 35', fn: r => r.energy > 35 },
    { label: '+ Agreement > 40', fn: r => r.agreement > 40 },
    { label: '+ London / London-NY', fn: r => r.session === 'LONDON' || r.session === 'LONDON_NY' },
    { label: '+ Ready or Pullback state', fn: r => r.state === 'READY_TO_ENTER' || r.state === 'PULLBACK_ACTIVE' || r.state === 'BASE_FORMING' },
  ];
  for (const f of filters1) {
    pool = pool.filter(f.fn);
    if (pool.length < 5) break;
    c1.push({ label: f.label, pool });
  }
  chains.push({
    name: 'The Complete Edge Stack',
    desc: 'CS Differential → Energy → Agreement → Session → State. The full conviction filter.',
    steps: c1.map(s => ({ label: s.label, ..._measurePool(s.pool) })),
  });

  // ── Chain 2: Energy-First Stack
  pool = all;
  const c2 = [{ label: 'All trades (baseline)', pool: all }];
  const filters2 = [
    { label: '+ Energy > 30', fn: r => r.energy > 30 },
    { label: '+ Movement > 25', fn: r => r.movement > 25 },
    { label: '+ Momentum > 25', fn: r => r.momentum > 25 },
    { label: '+ Dominance > 15', fn: r => r.dominance > 15 },
    { label: '+ Trending pairs > 5', fn: r => r.trend > 5 },
    { label: '+ Active pairs > 10', fn: r => r.active_pairs > 10 },
  ];
  for (const f of filters2) {
    pool = pool.filter(f.fn);
    if (pool.length < 5) break;
    c2.push({ label: f.label, pool });
  }
  chains.push({
    name: 'Energy-First Stack',
    desc: 'Energy → Movement → Momentum → Dominance → Trends → Liquidity. Market vitality filter.',
    steps: c2.map(s => ({ label: s.label, ..._measurePool(s.pool) })),
  });

  // ── Chain 3: Maximum Conviction
  pool = all;
  const c3 = [{ label: 'All trades (baseline)', pool: all }];
  const filters3 = [
    { label: '+ Energy > 45', fn: r => r.energy > 45 },
    { label: '+ Agreement > 55', fn: r => r.agreement > 55 },
    { label: '+ CS Diff > 0.003', fn: r => r.spread_6h > 0.003 },
    { label: '+ Confidence > 60', fn: r => r.confidence > 60 },
    { label: '+ Volatility 15–70', fn: r => r.volatility >= 15 && r.volatility <= 70 },
  ];
  for (const f of filters3) {
    pool = pool.filter(f.fn);
    if (pool.length < 5) break;
    c3.push({ label: f.label, pool });
  }
  chains.push({
    name: 'Maximum Conviction Filter',
    desc: 'Energy → Agreement → CS Diff → Confidence → Healthy Vol. Only the highest-quality setups.',
    steps: c3.map(s => ({ label: s.label, ..._measurePool(s.pool) })),
  });

  // ── Chain 4: Reversal Avoidance
  pool = all;
  const c4 = [{ label: 'All trades (baseline)', pool: all }];
  const filters4 = [
    { label: '+ Reversals < 6', fn: r => r.reversal < 6 },
    { label: '+ Volatility < 65', fn: r => r.volatility < 65 },
    { label: '+ Agreement > 30', fn: r => r.agreement > 30 },
    { label: '+ Energy > 20', fn: r => r.energy > 20 },
    { label: '+ Dominance > 10', fn: r => r.dominance > 10 },
  ];
  for (const f of filters4) {
    pool = pool.filter(f.fn);
    if (pool.length < 5) break;
    c4.push({ label: f.label, pool });
  }
  chains.push({
    name: 'Reversal Avoidance Filter',
    desc: 'Low reversals → Controlled vol → Agreement → Energy → Dominance. Removes structural danger.',
    steps: c4.map(s => ({ label: s.label, ..._measurePool(s.pool) })),
  });

  return { baseline, chains };
}

// ─── Cross-Component Heatmaps ───────────────────────────────────────────────
// 2D matrices showing win rate at intersections of two components

function analyzeHeatmaps(snapshots) {
  const all = _flattenOutcomes(snapshots, 'h4');
  if (all.length < 50) return [];

  const definitions = [
    {
      name: 'Energy × Agreement', x: 'energy', y: 'agreement',
      xRanges: [[0,20],[20,40],[40,60],[60,80],[80,100]],
      yRanges: [[0,20],[20,40],[40,60],[60,80],[80,100]],
    },
    {
      name: 'Movement × Momentum', x: 'movement', y: 'momentum',
      xRanges: [[0,20],[20,40],[40,60],[60,80],[80,100]],
      yRanges: [[0,20],[20,40],[40,60],[60,80],[80,100]],
    },
    {
      name: 'Energy × Dominance', x: 'energy', y: 'dominance',
      xRanges: [[0,20],[20,40],[40,60],[60,80],[80,100]],
      yRanges: [[0,15],[15,30],[30,45],[45,60],[60,100]],
    },
    {
      name: 'Agreement × Volatility', x: 'agreement', y: 'volatility',
      xRanges: [[0,20],[20,40],[40,60],[60,80],[80,100]],
      yRanges: [[0,20],[20,40],[40,60],[60,80],[80,100]],
    },
    {
      name: 'Active Pairs × Energy', x: 'active_pairs', y: 'energy',
      xRanges: [[0,5],[5,10],[10,15],[15,20],[20,28]],
      yRanges: [[0,20],[20,40],[40,60],[60,80],[80,100]],
    },
  ];

  const results = [];

  for (const def of definitions) {
    const xLabels = def.xRanges.map(([lo, hi]) => `${lo}–${hi}`);
    const yLabels = def.yRanges.map(([lo, hi]) => `${lo}–${hi}`);
    const cells = [];

    for (const [yLo, yHi] of def.yRanges) {
      const row = [];
      for (const [xLo, xHi] of def.xRanges) {
        const pool = all.filter(r => r[def.x] >= xLo && r[def.x] < xHi && r[def.y] >= yLo && r[def.y] < yHi);
        if (pool.length < 8) {
          row.push({ wr: null, samples: pool.length });
        } else {
          const wins = pool.filter(r => r.correct).length;
          row.push({
            wr: Math.round(wins / pool.length * 100),
            samples: pool.length,
            avg_fav: Math.round(pool.reduce((s, r) => s + r.fav, 0) / pool.length),
          });
        }
      }
      cells.push(row);
    }

    // Find best and worst cells
    let bestWR = 0, worstWR = 100, bestPos = null, worstPos = null;
    for (let y = 0; y < cells.length; y++) {
      for (let x = 0; x < cells[y].length; x++) {
        const c = cells[y][x];
        if (c.wr == null) continue;
        if (c.wr > bestWR && c.samples >= 15) { bestWR = c.wr; bestPos = { x: xLabels[x], y: yLabels[y] }; }
        if (c.wr < worstWR && c.samples >= 15) { worstWR = c.wr; worstPos = { x: xLabels[x], y: yLabels[y] }; }
      }
    }

    results.push({
      name: def.name, x_label: def.x, y_label: def.y,
      x_labels: xLabels, y_labels: yLabels, cells,
      best: bestPos ? { ...bestPos, wr: bestWR } : null,
      worst: worstPos ? { ...worstPos, wr: worstWR } : null,
    });
  }

  return results;
}

// ─── Regime-Specific Threshold Discovery ────────────────────────────────────
// Discovers optimal thresholds per market regime

function _classifyRegime(snap, prevSnap) {
  const e = snap.energy;
  if (e.market_energy < 12) return 'DEAD';
  if (e.market_energy < 25 && e.agreement < 30) return 'COMPRESSION';
  if (e.volatility > 55 && e.agreement < 30) return 'CHOPPY';
  if (prevSnap && e.market_energy > prevSnap.energy.market_energy + 8 && e.market_energy >= 25) return 'BREAKOUT';
  if (e.market_energy >= 60 && e.agreement >= 45) return 'EXPANSION';
  if (e.market_energy >= 45 && e.volatility > 50 && e.agreement < 35) return 'EXHAUSTION';
  if (e.market_energy >= 25 && e.market_energy < 45) return 'TRANSITION';
  return 'BUILDING';
}

function analyzeRegimeThresholds(snapshots) {
  // Classify each snapshot into a regime
  const regimeSnaps = {};
  for (let i = 0; i < snapshots.length; i++) {
    const regime = _classifyRegime(snapshots[i], i > 0 ? snapshots[i - 1] : null);
    if (!regimeSnaps[regime]) regimeSnaps[regime] = [];
    regimeSnaps[regime].push(snapshots[i]);
  }

  const results = {};
  const keyComponents = [
    { id: 'cs_diff', label: 'CS Differential', extract: r => r.spread_6h, thresholds: [0.001, 0.0015, 0.002, 0.0025, 0.003, 0.004, 0.005] },
    { id: 'energy', label: 'Market Energy', extract: r => r.energy, thresholds: [15, 25, 35, 45, 55, 65] },
    { id: 'agreement', label: 'Agreement', extract: r => r.agreement, thresholds: [15, 25, 35, 45, 55, 65] },
    { id: 'movement', label: 'Movement', extract: r => r.movement, thresholds: [15, 25, 35, 45, 55] },
    { id: 'confidence', label: 'Confidence', extract: r => r.confidence, thresholds: [40, 50, 60, 70, 80] },
  ];

  for (const [regime, snaps] of Object.entries(regimeSnaps)) {
    const all = _flattenOutcomes(snaps, 'h4');
    if (all.length < 20) { results[regime] = { hours: snaps.length, total_trades: all.length, insufficient: true }; continue; }

    const base = _measurePool(all);
    const thresholds = {};

    for (const comp of keyComponents) {
      let bestTh = null, bestWR = base.win_rate;
      for (const th of comp.thresholds) {
        const filtered = all.filter(r => comp.extract(r) >= th);
        if (filtered.length < 10) continue;
        const m = _measurePool(filtered);
        if (m.win_rate > bestWR) { bestWR = m.win_rate; bestTh = { threshold: th, ...m }; }
      }
      thresholds[comp.id] = bestTh || { threshold: null, note: 'No improvement found' };
    }

    results[regime] = { hours: snaps.length, total_trades: all.length, baseline: base, optimal: thresholds };
  }

  return results;
}

// ─── Session-Specific Threshold Discovery ───────────────────────────────────

function analyzeSessionThresholds(snapshots) {
  const sessionSnaps = {};
  for (const s of snapshots) {
    if (!sessionSnaps[s.session]) sessionSnaps[s.session] = [];
    sessionSnaps[s.session].push(s);
  }

  const keyComponents = [
    { id: 'cs_diff', label: 'CS Differential', extract: r => r.spread_6h, thresholds: [0.001, 0.0015, 0.002, 0.0025, 0.003, 0.004] },
    { id: 'energy', label: 'Market Energy', extract: r => r.energy, thresholds: [15, 25, 35, 45, 55, 65] },
    { id: 'agreement', label: 'Agreement', extract: r => r.agreement, thresholds: [15, 25, 35, 45, 55, 65] },
    { id: 'movement', label: 'Movement', extract: r => r.movement, thresholds: [10, 20, 30, 40, 50] },
    { id: 'dominance', label: 'Dominance', extract: r => r.dominance, thresholds: [5, 10, 15, 20, 30, 40] },
    { id: 'volatility', label: 'Volatility', extract: r => r.volatility, thresholds: [10, 20, 30, 40, 50] },
  ];

  const results = {};
  for (const [session, snaps] of Object.entries(sessionSnaps)) {
    const all = _flattenOutcomes(snaps, 'h4');
    if (all.length < 20) { results[session] = { hours: snaps.length, total_trades: all.length, insufficient: true }; continue; }

    const base = _measurePool(all);
    const optimal = {};

    for (const comp of keyComponents) {
      let bestTh = null, bestWR = base.win_rate;
      for (const th of comp.thresholds) {
        const filtered = all.filter(r => comp.extract(r) >= th);
        if (filtered.length < 10) continue;
        const m = _measurePool(filtered);
        if (m.win_rate > bestWR) { bestWR = m.win_rate; bestTh = { threshold: th, ...m }; }
      }
      optimal[comp.id] = bestTh || { threshold: null, note: 'No improvement found' };
    }

    results[session] = { hours: snaps.length, total_trades: all.length, baseline: base, optimal };
  }

  return results;
}

// ─── Transition Discovery ───────────────────────────────────────────────────
// What happens when market regime changes?

function analyzeTransitions(snapshots) {
  const transitions = {};

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const prevRegime = _classifyRegime(prev, i > 1 ? snapshots[i - 2] : null);
    const currRegime = _classifyRegime(curr, prev);

    if (prevRegime === currRegime) continue;

    const key = `${prevRegime} → ${currRegime}`;
    if (!transitions[key]) transitions[key] = { from: prevRegime, to: currRegime, snapshots: [] };
    transitions[key].snapshots.push(curr);
  }

  const results = [];
  for (const [key, t] of Object.entries(transitions)) {
    const outcomes = _flattenOutcomes(t.snapshots, 'h8');
    if (outcomes.length < 8) continue;

    const m = _measurePool(outcomes);
    results.push({
      transition: key, from: t.from, to: t.to,
      occurrences: t.snapshots.length, trades: m.samples,
      win_rate: m.win_rate, avg_fav: m.avg_fav, avg_adv: m.avg_adv, avg_net: m.avg_net,
    });
  }

  // Sort by win rate descending
  results.sort((a, b) => b.win_rate - a.win_rate);
  return results;
}

// ─── Edge Stability & Reliability ───────────────────────────────────────────
// Detects whether discovered edges are stable or decaying over time

function analyzeEdgeStability(snapshots) {
  const all = _flattenOutcomes(snapshots, 'h4');
  if (all.length < 50) return [];

  // Key conditions to test stability
  const conditions = [
    { name: 'CS Diff > 0.002', fn: r => r.spread_6h > 0.002 },
    { name: 'Energy > 40', fn: r => r.energy > 40 },
    { name: 'Agreement > 45', fn: r => r.agreement > 45 },
    { name: 'Energy > 40 + Agreement > 45', fn: r => r.energy > 40 && r.agreement > 45 },
    { name: 'CS > 0.002 + Energy > 35 + Agreement > 35', fn: r => r.spread_6h > 0.002 && r.energy > 35 && r.agreement > 35 },
    { name: 'London/NY + Energy > 35', fn: r => (r.session === 'LONDON' || r.session === 'LONDON_NY') && r.energy > 35 },
    { name: 'Ready-to-Enter state', fn: r => r.state === 'READY_TO_ENTER' },
    { name: 'Dominance > 20 + Movement > 30', fn: r => r.dominance > 20 && r.movement > 30 },
  ];

  // Group all trades by month
  const byMonth = {};
  for (const r of all) {
    const month = r.time.slice(0, 7); // YYYY-MM
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(r);
  }
  const months = Object.keys(byMonth).sort();

  const results = [];

  for (const cond of conditions) {
    const filtered = all.filter(cond.fn);
    if (filtered.length < 20) continue;

    const overall = _measurePool(filtered);

    // Monthly win rates
    const monthlyWR = [];
    for (const m of months) {
      const mPool = (byMonth[m] || []).filter(cond.fn);
      if (mPool.length < 5) { monthlyWR.push({ month: m, wr: null, samples: mPool.length }); continue; }
      const wins = mPool.filter(r => r.correct).length;
      monthlyWR.push({ month: m, wr: Math.round(wins / mPool.length * 100), samples: mPool.length });
    }

    // Compute variance of valid months
    const validWRs = monthlyWR.filter(m => m.wr != null).map(m => m.wr);
    const mean = validWRs.length ? validWRs.reduce((a, b) => a + b, 0) / validWRs.length : 0;
    const variance = validWRs.length > 1 ? Math.round(Math.sqrt(validWRs.reduce((s, w) => s + (w - mean) ** 2, 0) / (validWRs.length - 1))) : 0;

    // Recent vs historical
    const recentMonths = months.slice(-3);
    const olderMonths = months.slice(0, -3);
    const recentPool = recentMonths.flatMap(m => (byMonth[m] || []).filter(cond.fn));
    const olderPool = olderMonths.flatMap(m => (byMonth[m] || []).filter(cond.fn));
    const recentWR = recentPool.length >= 10 ? Math.round(recentPool.filter(r => r.correct).length / recentPool.length * 100) : null;
    const olderWR = olderPool.length >= 10 ? Math.round(olderPool.filter(r => r.correct).length / olderPool.length * 100) : null;

    // Decay detection
    let decay = 'STABLE';
    if (recentWR != null && olderWR != null) {
      if (recentWR < olderWR - 8) decay = 'DECAYING';
      else if (recentWR > olderWR + 8) decay = 'IMPROVING';
    }

    // Stability score (0-100): penalise high variance, low samples, and decay
    const sampleScore = Math.min(100, filtered.length / 5);
    const varianceScore = Math.max(0, 100 - variance * 3);
    const decayScore = decay === 'STABLE' ? 100 : decay === 'IMPROVING' ? 100 : 50;
    const stabilityScore = Math.round(sampleScore * 0.3 + varianceScore * 0.4 + decayScore * 0.3);

    results.push({
      condition: cond.name,
      total_samples: filtered.length,
      overall_wr: overall.win_rate,
      monthly_wr: monthlyWR,
      variance,
      recent_3m_wr: recentWR,
      older_wr: olderWR,
      decay,
      stability_score: stabilityScore,
    });
  }

  // Sort by stability score descending
  results.sort((a, b) => b.stability_score - a.stability_score);
  return results;
}

// ─── Probability Curves ─────────────────────────────────────────────────────
// Progressive probability instead of hard thresholds

function analyzeProbabilityCurves(snapshots) {
  const all = _flattenOutcomes(snapshots, 'h4');
  if (all.length < 50) return [];

  const components = [
    { id: 'cs_diff', name: 'CS Differential', extract: r => r.spread_6h,
      points: [0.0005, 0.001, 0.0015, 0.002, 0.0025, 0.003, 0.004, 0.005, 0.007, 0.01] },
    { id: 'energy', name: 'Market Energy', extract: r => r.energy,
      points: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80] },
    { id: 'agreement', name: 'Agreement', extract: r => r.agreement,
      points: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80] },
    { id: 'movement', name: 'Movement', extract: r => r.movement,
      points: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80] },
    { id: 'dominance', name: 'Dominance', extract: r => r.dominance,
      points: [0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 60] },
    { id: 'active_pairs', name: 'Active Pairs', extract: r => r.active_pairs,
      points: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20] },
    { id: 'confidence', name: 'Confidence', extract: r => r.confidence,
      points: [30, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85] },
  ];

  const results = [];

  for (const comp of components) {
    const curve = [];
    for (const threshold of comp.points) {
      const pool = all.filter(r => comp.extract(r) >= threshold);
      if (pool.length < 8) { curve.push({ threshold, wr: null, samples: pool.length }); continue; }
      const wins = pool.filter(r => r.correct).length;
      const wr = Math.round(wins / pool.length * 100);
      const avgFav = Math.round(pool.reduce((s, r) => s + r.fav, 0) / pool.length);
      curve.push({ threshold, wr, samples: pool.length, avg_fav: avgFav });
    }

    // Find the inflection point (where WR crosses 55%)
    let edgeThreshold = null;
    for (const pt of curve) {
      if (pt.wr != null && pt.wr >= 55 && pt.samples >= 15) { edgeThreshold = pt.threshold; break; }
    }

    results.push({ id: comp.id, name: comp.name, curve, edge_threshold: edgeThreshold });
  }

  return results;
}

// ─── Save result ─────────────────────────────────────────────────────────────

async function saveBacktestResult(result) {
  const summary = result.analysis;
  const row = {
    run_date: new Date().toISOString(),
    date_from: result.config.from,
    date_to: result.config.to,
    instruments: config.instruments.length,
    bars_replayed: result.snapshots_analyzed,
    total_trades: 0,
    wins: 0,
    losses: 0,
    win_rate: 0,
    total_pips: 0,
    profit_factor: 0,
    max_drawdown: 0,
    avg_win: 0,
    avg_loss: 0,
    duration_sec: result.duration_sec,
    details: summary,
  };

  const { data, error } = await supabase
    .from('backtest_results')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    console.warn('[BACKTEST] Save error:', error.message);
    return null;
  }
  return data.id;
}

// ─── AI Interpretation Engine ───────────────────────────────────────────────
// Generates plain-English insights from raw analysis data so every user
// can understand what the numbers mean and what to do about them.

function interpretAnalysis(analysis) {
  return {
    component_thresholds: interpretComponents(analysis.component_thresholds),
    conditional_edge:     interpretConditional(analysis.conditional_edge),
    heatmaps:             interpretHeatmaps(analysis.heatmaps),
    regime_thresholds:    interpretRegimes(analysis.regime_thresholds),
    session_thresholds:   interpretSessionTh(analysis.session_thresholds),
    transitions:          interpretTransitions(analysis.transitions),
    edge_stability:       interpretStability(analysis.edge_stability),
    probability_curves:   interpretProbability(analysis.probability_curves),
    energy_thresholds:    interpretEnergy(analysis.energy_thresholds),
    strength_thresholds:  interpretStrength(analysis.strength_thresholds),
    state_outcomes:       interpretStates(analysis.state_outcomes),
    no_trade_zones:       interpretNoTrade(analysis.no_trade_zones),
    condition_combos:     interpretCombos(analysis.condition_combos),
    move_distance:        interpretDistance(analysis.move_distance),
    session_performance:  interpretSessions(analysis.session_performance),
  };
}

// ── Conditional Edge interpretation ──

function interpretConditional(data) {
  if (!data?.chains?.length) return { summary: 'Not enough data for conditional analysis.', bullets: [] };
  const bullets = [];

  for (const chain of data.chains) {
    if (chain.steps.length < 2) continue;
    const first = chain.steps[0];
    const last = chain.steps[chain.steps.length - 1];
    if (!first || !last) continue;
    const lift = last.win_rate - first.win_rate;
    bullets.push(`"${chain.name}" — stacking ${chain.steps.length - 1} filters lifts win rate from ${first.win_rate}% to ${last.win_rate}% (+${lift}pp), though sample drops from ${first.samples} to ${last.samples}. ${lift >= 15 ? 'This is a massive edge improvement.' : lift >= 8 ? 'Meaningful improvement — worth applying.' : 'Modest improvement — other chains may work better.'}`);

    // Find the biggest single-step jump
    let maxJump = 0, jumpLabel = '';
    for (let i = 1; i < chain.steps.length; i++) {
      const jump = chain.steps[i].win_rate - chain.steps[i - 1].win_rate;
      if (jump > maxJump) { maxJump = jump; jumpLabel = chain.steps[i].label; }
    }
    if (maxJump >= 5) {
      bullets.push(`In "${chain.name}", the single biggest improvement comes from "${jumpLabel}" (+${maxJump}pp). This is the most impactful filter in the chain.`);
    }
  }

  // Find best final win rate across chains
  const best = data.chains.reduce((a, c) => {
    const last = c.steps[c.steps.length - 1];
    return last && last.win_rate > (a?.wr || 0) ? { name: c.name, wr: last.win_rate, samples: last.samples } : a;
  }, null);

  const summary = best
    ? `Multi-factor analysis reveals that stacking conditions is transformative. "${best.name}" reaches ${best.wr}% win rate when all filters align. Single-factor analysis never shows this — the real edge lives in combinations.`
    : 'Conditional edge analysis shows how stacking filters improves trade quality.';

  return { summary, bullets };
}

// ── Heatmap interpretation ──

function interpretHeatmaps(data) {
  if (!data?.length) return { summary: 'Not enough data for heatmap analysis.', bullets: [] };
  const bullets = [];

  for (const hm of data) {
    if (hm.best && hm.worst) {
      bullets.push(`${hm.name}: best zone is ${hm.x_label} ${hm.best.x} × ${hm.y_label} ${hm.best.y} at ${hm.best.wr}% WR. Worst: ${hm.worst.x} × ${hm.worst.y} at ${hm.worst.wr}% WR. Spread: ${hm.best.wr - hm.worst.wr} percentage points — the interaction between these two components creates a massive edge difference.`);
    }
  }

  const summary = 'Cross-component heatmaps reveal where edge clusters in 2D space. No single indicator tells the full story — the interaction between components creates non-linear edges that only appear when you look at both dimensions simultaneously.';
  return { summary, bullets };
}

// ── Regime threshold interpretation ──

function interpretRegimes(data) {
  if (!data || !Object.keys(data).length) return { summary: 'Not enough data for regime analysis.', bullets: [] };
  const bullets = [];

  for (const [regime, d] of Object.entries(data)) {
    if (d.insufficient) continue;
    const optEntries = Object.entries(d.optimal || {}).filter(([_, v]) => v.threshold != null);
    if (!optEntries.length) {
      bullets.push(`${regime}: baseline ${d.baseline?.win_rate}% WR across ${d.total_trades} trades. No component filter significantly improves this — the regime itself determines quality.`);
      continue;
    }
    const best = optEntries.reduce((a, [k, v]) => v.win_rate > (a?.v?.win_rate || 0) ? { k, v } : a, null);
    if (best) {
      bullets.push(`${regime}: baseline ${d.baseline?.win_rate}% WR. Best filter: ${best.k} ≥ ${best.v.threshold} lifts to ${best.v.win_rate}% (${best.v.samples} trades). Thresholds in this regime are fundamentally different from global averages.`);
    }
  }

  // Find best and worst regimes
  const regimeWRs = Object.entries(data).filter(([_, d]) => !d.insufficient && d.baseline).sort((a, b) => b[1].baseline.win_rate - a[1].baseline.win_rate);
  if (regimeWRs.length >= 2) {
    bullets.push(`Best regime: ${regimeWRs[0][0]} at ${regimeWRs[0][1].baseline.win_rate}% baseline WR. Worst: ${regimeWRs[regimeWRs.length - 1][0]} at ${regimeWRs[regimeWRs.length - 1][1].baseline.win_rate}% WR. The same setup performs completely differently depending on market regime.`);
  }

  const summary = 'Thresholds change fundamentally between market regimes. A CS Differential that works in Expansion may fail in Compression. Regime-aware thresholds are essential for real-world edge.';
  return { summary, bullets };
}

// ── Session threshold interpretation ──

function interpretSessionTh(data) {
  if (!data || !Object.keys(data).length) return { summary: 'Not enough data for session threshold analysis.', bullets: [] };
  const bullets = [];

  for (const [session, d] of Object.entries(data)) {
    if (d.insufficient) continue;
    const optEntries = Object.entries(d.optimal || {}).filter(([_, v]) => v.threshold != null);
    if (!optEntries.length) continue;

    const parts = optEntries.map(([k, v]) => `${k} ≥ ${v.threshold}`).join(', ');
    const best = optEntries.reduce((a, [k, v]) => v.win_rate > (a?.v?.win_rate || 0) ? { k, v } : a, null);
    bullets.push(`${session}: optimal filters are ${parts}. ${best ? `Best single filter: ${best.k} ≥ ${best.v.threshold} → ${best.v.win_rate}% WR (base: ${d.baseline?.win_rate}%).` : ''}`);
  }

  const summary = 'Each trading session has different optimal thresholds. Asia needs higher agreement to filter noise. London tolerates higher volatility. NY rewards directional dominance. Using global thresholds across all sessions leaves edge on the table.';
  return { summary, bullets };
}

// ── Transition interpretation ──

function interpretTransitions(data) {
  if (!data?.length) return { summary: 'Not enough data for transition analysis.', bullets: [] };
  const bullets = [];

  const best = data[0]; // Already sorted by win rate
  if (best) {
    bullets.push(`Best transition: ${best.transition} at ${best.win_rate}% WR with ${best.avg_fav}p favourable move (${best.trades} trades). ${best.win_rate >= 60 ? 'This is an elite-level entry window.' : 'Worth targeting when this shift occurs.'}`);
  }

  const worst = data[data.length - 1];
  if (worst && worst.win_rate < 48) {
    bullets.push(`Worst transition: ${worst.transition} at ${worst.win_rate}% WR. ${worst.win_rate < 42 ? 'Trades taken during this shift are net losers — add to no-trade filter.' : 'Weak edge during this regime change.'}`);
  }

  const breakouts = data.filter(t => t.to === 'BREAKOUT' || t.to === 'EXPANSION');
  if (breakouts.length) {
    const avgWR = Math.round(breakouts.reduce((s, t) => s + t.win_rate, 0) / breakouts.length);
    bullets.push(`Transitions INTO expansion/breakout average ${avgWR}% WR. ${avgWR >= 58 ? 'Confirmed: catching the regime shift is one of the highest-edge strategies.' : 'Expansion entries show an edge, but regime timing must be precise.'}`);
  }

  const summary = 'Markets move in transitions, not static states. The moment a regime changes is where the biggest opportunities and dangers live. Static analysis misses these windows entirely.';
  return { summary, bullets };
}

// ── Edge stability interpretation ──

function interpretStability(data) {
  if (!data?.length) return { summary: 'Not enough data for stability analysis.', bullets: [] };
  const bullets = [];

  const stable = data.filter(d => d.decay === 'STABLE' && d.stability_score >= 70);
  const decaying = data.filter(d => d.decay === 'DECAYING');
  const improving = data.filter(d => d.decay === 'IMPROVING');

  if (stable.length) {
    bullets.push(`${stable.length} condition(s) show STABLE edge over time: ${stable.map(s => `"${s.condition}" (${s.stability_score}/100)`).join(', ')}. These are your most reliable trading rules.`);
  }

  if (decaying.length) {
    for (const d of decaying) {
      bullets.push(`WARNING — "${d.condition}" is DECAYING: historical ${d.older_wr}% WR → recent 3 months ${d.recent_3m_wr}% WR. This edge may be disappearing. Reduce reliance or investigate why.`);
    }
  }

  if (improving.length) {
    for (const d of improving) {
      bullets.push(`IMPROVING — "${d.condition}": recent 3 months ${d.recent_3m_wr}% WR vs historical ${d.older_wr}% WR. Current market regime is favouring this condition.`);
    }
  }

  // Highest stability score
  const best = data[0]; // Already sorted by stability
  if (best) {
    bullets.push(`Most reliable condition: "${best.condition}" with stability score ${best.stability_score}/100, variance ±${best.variance}pp, overall ${best.overall_wr}% WR.`);
  }

  const summary = decaying.length
    ? `${decaying.length} edge(s) are decaying — recently performing worse than historically. ${stable.length} edge(s) remain stable. Trust stable edges and reduce exposure to decaying ones.`
    : `${stable.length} tested condition(s) show stable edge across the entire period. No significant edge decay detected.`;

  return { summary, bullets };
}

// ── Probability curve interpretation ──

function interpretProbability(data) {
  if (!data?.length) return { summary: 'Not enough data for probability analysis.', bullets: [] };
  const bullets = [];

  for (const comp of data) {
    if (!comp.edge_threshold) continue;
    const edgePt = comp.curve.find(p => p.threshold === comp.edge_threshold);
    if (!edgePt) continue;
    bullets.push(`${comp.name}: probability of continuation crosses 55% at threshold ${comp.edge_threshold}. Below this, trades are coin flips. Above this, edge scales progressively.`);

    // Find the steepest improvement section
    let maxSlope = 0, slopeRange = '';
    for (let i = 1; i < comp.curve.length; i++) {
      if (comp.curve[i].wr == null || comp.curve[i - 1].wr == null) continue;
      const slope = comp.curve[i].wr - comp.curve[i - 1].wr;
      if (slope > maxSlope) { maxSlope = slope; slopeRange = `${comp.curve[i - 1].threshold} → ${comp.curve[i].threshold}`; }
    }
    if (maxSlope >= 4) {
      bullets.push(`${comp.name} probability jumps fastest between ${slopeRange} (+${maxSlope}pp). This is the critical zone where the indicator transitions from noise to signal.`);
    }
  }

  const summary = 'Markets are probabilistic, not binary. These curves show how the probability of continuation rises progressively with each indicator — there is no magic number, but there ARE inflection points where edge materially appears.';
  return { summary, bullets };
}

// ── Per-component threshold interpretation ──

function interpretComponents(components) {
  if (!components || !components.length) return [];

  return components.map(comp => {
    const insight = { summary: '', bullets: [] };
    const ranges = comp.ranges || {};
    const validRanges = Object.entries(ranges).filter(([_, r]) => !r.insufficient && r.win_rate != null);

    if (validRanges.length < 2) {
      insight.summary = `Not enough data to determine reliable thresholds for ${comp.name}.`;
      return { id: comp.id, ...insight };
    }

    // Sort by range order (ascending by lower bound from label)
    const sorted = validRanges.sort((a, b) => {
      const aNum = parseFloat(a[0].split('–')[0]) || 0;
      const bNum = parseFloat(b[0].split('–')[0]) || 0;
      return aNum - bNum;
    });

    // Best range
    if (comp.best_range && comp.best_win_rate > 0) {
      const bestData = ranges[comp.best_range];
      if (bestData && !bestData.insufficient) {
        insight.summary = `${comp.name}: optimal threshold is ${comp.best_range}${comp.unit}. At this level, trades continue in the expected direction ${comp.best_win_rate}% of the time with ${bestData.avg_fav}p average favourable move.`;
      }
    }

    // Minimum edge threshold
    if (comp.min_edge_threshold) {
      const edgeData = ranges[comp.min_edge_threshold];
      if (edgeData) {
        insight.bullets.push(`Minimum for edge: ${comp.name} must be at least ${comp.min_edge_threshold}${comp.unit} before you have any statistical advantage (${edgeData.win_rate}% win rate, ${edgeData.trades} trades measured).`);
      }
    }

    // Sweet spot
    if (comp.best_range) {
      const bestData = ranges[comp.best_range];
      if (bestData && !bestData.insufficient) {
        const rr = bestData.avg_adv > 0 ? (bestData.avg_fav / bestData.avg_adv).toFixed(1) : '∞';
        insight.bullets.push(`Sweet spot: ${comp.best_range}${comp.unit} delivers ${comp.best_win_rate}% win rate, +${bestData.avg_fav}p favourable vs -${bestData.avg_adv}p adverse (${rr}:1 reward-to-risk). ${bestData.hours} hours observed at this level.`);
      }
    }

    // Danger zone
    if (comp.worst_range && comp.worst_win_rate < 48) {
      const worstData = ranges[comp.worst_range];
      if (worstData && !worstData.insufficient) {
        insight.bullets.push(`Danger zone: ${comp.worst_range}${comp.unit} shows only ${comp.worst_win_rate}% win rate with -${worstData.avg_adv}p average adverse move. Trades at this level are net losers — avoid or reduce size.`);
      }
    }

    // Best movement range
    if (comp.best_move_range && comp.best_avg_move > 0) {
      insight.bullets.push(`Largest moves: when ${comp.name.toLowerCase()} is ${comp.best_move_range}${comp.unit}, price averages ${comp.best_avg_move}p maximum excursion at 4H. Set TP targets accordingly.`);
    }

    // Trend across ranges — does higher = better?
    if (sorted.length >= 3) {
      const firstHalf = sorted.slice(0, Math.floor(sorted.length / 2));
      const secondHalf = sorted.slice(Math.floor(sorted.length / 2));
      const avgFirst = Math.round(firstHalf.reduce((s, [_, r]) => s + r.win_rate, 0) / firstHalf.length);
      const avgSecond = Math.round(secondHalf.reduce((s, [_, r]) => s + r.win_rate, 0) / secondHalf.length);

      if (avgSecond > avgFirst + 5) {
        insight.bullets.push(`Higher is better: win rate improves from ${avgFirst}% at lower values to ${avgSecond}% at higher values. The relationship is clear — wait for stronger readings before entering.`);
      } else if (avgFirst > avgSecond + 5) {
        insight.bullets.push(`Caution at extremes: lower ${comp.name.toLowerCase()} readings (${avgFirst}% WR) actually outperform higher ones (${avgSecond}% WR). Very high values may signal exhaustion or choppy conditions.`);
      } else {
        insight.bullets.push(`Mixed relationship: win rate stays around ${Math.round((avgFirst + avgSecond) / 2)}% across all levels. This component alone doesn't strongly predict direction — combine with other filters.`);
      }
    }

    // Component-specific contextual insight
    const ctx = _componentContext(comp, ranges, sorted);
    if (ctx) insight.bullets.push(ctx);

    if (!insight.summary) {
      insight.summary = `${comp.name} analysis across ${validRanges.reduce((s, [_, r]) => s + r.trades, 0)} trades at ${validRanges.reduce((s, [_, r]) => s + r.hours, 0)} hourly snapshots.`;
    }

    return { id: comp.id, ...insight };
  });
}

function _componentContext(comp, ranges, sorted) {
  switch (comp.id) {
    case 'movement':
      return 'Movement reflects actual pip displacement across all pairs. Low movement = ranging/dead market. High movement = directional flow. Your entries need movement above the minimum threshold to have follow-through.';
    case 'momentum':
      return 'Momentum (breadth) measures how many pairs participate in the move. Wide breadth = real institutional flow. Narrow breadth = isolated pair move that can reverse quickly.';
    case 'agreement':
      return 'Agreement measures whether active pairs are aligned with currency strength. High agreement = currencies are driving the move. Low agreement = random noise, pairs moving against their strength profile.';
    case 'volatility':
      return 'Volatility shows candle range intensity. Moderate volatility enables good entries; extreme volatility often means whipsaw and wide stops that destroy risk/reward.';
    case 'market_energy':
      return 'Market Energy is the master composite — the single best reading for overall market tradability. It weights movement (40%), breadth (30%), agreement (20%), and volatility (10%), adjusted by quality.';
    case 'bull_pressure':
      return 'Bull pressure above 65% signals strong upside bias across the board. Look for BUY setups on pairs where base currency is strong. Below 35% means bears dominate — flip to SELL bias.';
    case 'bear_pressure':
      return 'Bear pressure above 65% signals broad selling pressure. SELL setups on pairs with weak base currency are favoured. Below 35% means bulls control — flip to BUY bias.';
    case 'dominance':
      return 'Dominance measures how one-sided the market is (|bull − bear|). High dominance = clear directional conviction, ideal for trend trades. Low dominance = tug-of-war, favour range strategies or stay out.';
    case 'active_pairs':
      return 'Active pairs is your liquidity gauge. Below 5 active pairs means the market is effectively dead — no edge exists. Above 15 means broad participation and reliable setups.';
    case 'strength_diff':
      return 'The gap between strongest and weakest currency is the fundamental driver. Larger gaps create pairs with strong directional bias. This is the #1 filter for trade quality.';
    case 'ready_count':
      return 'Ready-to-enter count shows how many pairs have completed the ideal pullback cycle. 0 means no setups exist now. 3+ means multiple high-quality entries are available simultaneously.';
    case 'trend_count':
      return 'Trend count shows how many pairs are in active directional movement. High trend count = strong market conviction. Very low count with high energy = possible reversal forming.';
    case 'pullback_count':
      return 'Pullback count is your pipeline indicator — these pairs are building toward entries. A rising pullback count after a strong trend phase means entries are about to appear.';
    case 'reversal_count':
      return 'Reversal count is a danger signal. Many pairs reversing simultaneously means the macro trend is exhausting. Reduce exposure and tighten stops when reversals spike above the danger threshold.';
    case 'avg_confidence':
      return 'Average confidence reflects overall state machine certainty. Low confidence = ambiguous signals, expect more false entries. High confidence = the pattern is clear and well-confirmed.';
    case 'max_spread':
      return 'Max pair spread shows the strongest individual setup available. Large max spread means at least one pair has extreme strength divergence — often your best trade of the day.';
    default:
      return null;
  }
}

// ── Energy thresholds ──

function interpretEnergy(data) {
  if (!data?.by_component) return { summary: 'Not enough data to analyze energy thresholds.', bullets: [] };

  const bullets = [];
  let bestComp = '', bestRange = '', bestRate = 0;
  let worstComp = '', worstRange = '', worstRate = 100;

  for (const [comp, ranges] of Object.entries(data.by_component)) {
    const keys = Object.keys(ranges).sort();
    for (const k of keys) {
      const d = ranges[k];
      if (d.pairs_measured < 20) continue;
      if (d.continuation_rate > bestRate)  { bestRate = d.continuation_rate;  bestComp = comp; bestRange = k; }
      if (d.continuation_rate < worstRate) { worstRate = d.continuation_rate; worstComp = comp; worstRange = k; }
    }
  }

  // Market energy sweet spot
  const me = data.by_component.market_energy;
  if (me) {
    const sorted = Object.entries(me).sort((a, b) => b[1].continuation_rate - a[1].continuation_rate);
    if (sorted.length >= 2) {
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      bullets.push(`The market moves most reliably when overall energy is in the ${best[0]} range (${best[1].continuation_rate}% continuation on ${best[1].pairs_measured} trades). This is your sweet spot for entries.`);
      bullets.push(`Energy in the ${worst[0]} range shows the weakest follow-through (${worst[1].continuation_rate}%). Trades taken here are more likely to chop sideways.`);
    }
  }

  // Best individual component
  if (bestComp) {
    const label = bestComp.replace('_', ' ');
    bullets.push(`Strongest signal: when ${label} is ${bestRange}, the market continues in the expected direction ${bestRate}% of the time. Prioritize this reading above others.`);
  }

  // Agreement insight
  const agr = data.by_component.agreement;
  if (agr) {
    const highAgr = agr['60-80'] || agr['80-100'];
    const lowAgr  = agr['0-20'];
    if (highAgr && lowAgr) {
      const diff = highAgr.continuation_rate - lowAgr.continuation_rate;
      if (diff > 5) {
        bullets.push(`Agreement matters: high agreement (60+) produces ${diff} percentage points better continuation than low agreement (0-20). When currencies disagree on direction, stay out.`);
      }
    }
  }

  // Movement vs volatility
  const mov = data.by_component.movement;
  const vol = data.by_component.volatility;
  if (mov && vol) {
    const highMov = mov['60-80'] || mov['80-100'];
    const highVol = vol['60-80'] || vol['80-100'];
    if (highMov && highVol && highMov.continuation_rate > highVol.continuation_rate + 5) {
      bullets.push(`Steady movement beats raw volatility. High movement scores predict continuation better than high volatility, which often means whipsaw and noise.`);
    }
  }

  // Summary
  const summary = bestComp
    ? `The data reveals that ${bestComp.replace('_', ' ')} in the ${bestRange} range is your most reliable energy signal. Focus your entries when this condition is met and overall energy sits in the optimal zone.`
    : 'The energy analysis shows how each component of market activity affects trade continuation.';

  return { summary, bullets };
}

// ── Strength thresholds ──

function interpretStrength(data) {
  if (!data || !Object.keys(data).length) return { summary: 'Not enough data to analyze strength thresholds.', bullets: [] };

  const bullets = [];
  const sorted = Object.entries(data).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

  // Find crossover point where continuation becomes profitable
  let crossover = null;
  for (const [key, d] of sorted) {
    if (d.continuation_rate >= 55 && d.samples >= 20) {
      crossover = { key, ...d };
      break;
    }
  }

  if (crossover) {
    bullets.push(`Currency strength differential of ${crossover.key} or higher gives you a reliable edge: ${crossover.continuation_rate}% continuation rate across ${crossover.samples} trades. Below this level, trades are essentially coin flips.`);
  }

  // Best tier
  const best = sorted.reduce((a, b) => (b[1].continuation_rate > (a?.[1]?.continuation_rate || 0) && b[1].samples >= 15) ? b : a, null);
  if (best) {
    bullets.push(`Strongest edge: spread differential at ${best[0]} shows ${best[1].continuation_rate}% continuation, averaging +${best[1].avg_favourable_pips} pips favourable vs -${best[1].avg_adverse_pips} pips adverse. The reward-to-risk from strength alone is ${(best[1].avg_favourable_pips / Math.max(1, best[1].avg_adverse_pips)).toFixed(1)}:1.`);
  }

  // Weak tier warning
  const weakest = sorted.find(([_, d]) => d.continuation_rate < 50 && d.samples >= 20);
  if (weakest) {
    bullets.push(`Weak differentials (${weakest[0]}) show only ${weakest[1].continuation_rate}% continuation with ${weakest[1].avg_adverse_pips} pips of adverse movement. These are the trades that stop you out before moving — avoid them.`);
  }

  // Risk/reward insight
  const bigSpread = sorted[sorted.length - 1];
  const smallSpread = sorted[0];
  if (bigSpread && smallSpread && bigSpread[1].samples >= 10 && smallSpread[1].samples >= 10) {
    const bigRR = bigSpread[1].avg_favourable_pips / Math.max(1, bigSpread[1].avg_adverse_pips);
    const smallRR = smallSpread[1].avg_favourable_pips / Math.max(1, smallSpread[1].avg_adverse_pips);
    if (bigRR > smallRR + 0.3) {
      bullets.push(`Larger strength gaps produce fundamentally better risk/reward: ${bigRR.toFixed(1)}:1 at ${bigSpread[0]} vs ${smallRR.toFixed(1)}:1 at ${smallSpread[0]}. Patience for wider spreads pays off.`);
    }
  }

  const summary = crossover
    ? `Currency strength differential is a strong filter. The minimum threshold for a reliable trade is a spread of ${crossover.key}. Below that, price action is too random to trade with an edge.`
    : 'The analysis shows how currency strength differentials correlate with trade outcomes. Larger differentials generally improve continuation probability.';

  return { summary, bullets };
}

// ── State outcomes ──

function interpretStates(data) {
  if (!data || !Object.keys(data).length) return { summary: 'Not enough data to analyze state outcomes.', bullets: [] };

  const bullets = [];
  const sorted = Object.entries(data).sort((a, b) => b[1].win_rate - a[1].win_rate);

  // Best state
  const best = sorted.find(([_, d]) => d.samples >= 20);
  if (best) {
    bullets.push(`${best[0].replace(/_/g, ' ')} is the highest-probability entry state at ${best[1].win_rate}% win rate across ${best[1].samples} trades. This is the state the engine should target for entries.`);
  }

  // READY_TO_ENTER specifically
  const ready = data['READY_TO_ENTER'];
  if (ready && ready.samples >= 10) {
    bullets.push(`READY TO ENTER signals delivered ${ready.win_rate}% win rate with +${ready.avg_favourable} pips average favourable move and -${ready.avg_adverse} pips adverse. ${ready.win_rate >= 55 ? 'This confirms the state machine is correctly identifying entry windows.' : 'This state needs tighter filters to improve accuracy.'}`);
  }

  // TREND state
  const trend = data['TREND'];
  if (trend && trend.samples >= 10) {
    bullets.push(`Taking trades during TREND state (before pullback) shows ${trend.win_rate}% win rate. ${trend.win_rate < 50 ? 'This confirms that waiting for a pullback before entering is critical — chasing trends hurts performance.' : 'Trend-following entries show decent accuracy, but pullback entries likely offer better risk/reward.'}`);
  }

  // Worst states
  const avoid = sorted.filter(([_, d]) => d.win_rate < 45 && d.samples >= 15);
  if (avoid.length) {
    const names = avoid.map(([s]) => s.replace(/_/g, ' ')).join(', ');
    bullets.push(`States to avoid completely: ${names}. These produce sub-45% win rates — you lose money trading them regardless of other conditions.`);
  }

  // Confidence correlation
  const highConf = sorted.filter(([_, d]) => d.avg_confidence >= 70 && d.samples >= 10);
  const lowConf  = sorted.filter(([_, d]) => d.avg_confidence < 50 && d.samples >= 10);
  if (highConf.length && lowConf.length) {
    const avgHigh = Math.round(highConf.reduce((s, [_, d]) => s + d.win_rate, 0) / highConf.length);
    const avgLow  = Math.round(lowConf.reduce((s, [_, d]) => s + d.win_rate, 0) / lowConf.length);
    if (avgHigh > avgLow + 5) {
      bullets.push(`Confidence scores matter: states with 70+ confidence average ${avgHigh}% win rate vs ${avgLow}% for sub-50 confidence. Trust the confidence reading.`);
    }
  }

  const summary = best
    ? `The state machine analysis reveals ${best[0].replace(/_/g, ' ')} as the optimal entry state. ${avoid.length ? `${avoid.length} state(s) should be filtered out entirely as they consistently lose money.` : ''}`
    : 'State outcome analysis shows how each market state performs when trades are taken.';

  return { summary, bullets };
}

// ── No-trade zones ──

function interpretNoTrade(zones) {
  if (!zones || !zones.length) return { summary: 'No clear no-trade zones were detected in the historical data.', bullets: [] };

  const bullets = [];
  const avoidZones = zones.filter(z => z.verdict === 'AVOID');
  const cautionZones = zones.filter(z => z.verdict === 'CAUTION');

  if (avoidZones.length) {
    bullets.push(`${avoidZones.length} market condition(s) are confirmed danger zones where trades consistently lose money. The engine should automatically block entries when these conditions are present.`);
    for (const z of avoidZones) {
      bullets.push(`DANGER: "${z.condition}" — only ${z.win_rate}% win rate across ${z.samples} trades with average ${z.avg_pips} pips per trade. Every trade taken here costs you money.`);
    }
  }

  if (cautionZones.length) {
    for (const z of cautionZones) {
      bullets.push(`CAUTION: "${z.condition}" — ${z.win_rate}% win rate. Not a clear loser, but the edge is thin. Reduce position size or require additional confirmation before entering.`);
    }
  }

  const totalSaved = avoidZones.reduce((s, z) => s + Math.abs(z.avg_pips) * z.samples, 0);
  if (totalSaved > 0) {
    bullets.push(`By avoiding just these ${avoidZones.length} conditions, you would have dodged approximately ${Math.round(totalSaved)} pips of losses in the test period.`);
  }

  const summary = avoidZones.length
    ? `${avoidZones.length} no-trade zone(s) confirmed. These conditions produce consistently negative results and should be hard-coded as trade blockers in your system.`
    : 'Some market conditions show reduced edge but none are confirmed money-losers. Use caution flags rather than hard blocks.';

  return { summary, bullets };
}

// ── Condition combos ──

function interpretCombos(combos) {
  if (!combos || !combos.length) return { summary: 'Not enough data to identify condition combinations.', bullets: [] };

  const bullets = [];
  const strong = combos.filter(c => c.verdict === 'STRONG_ENTRY');
  const opps   = combos.filter(c => c.verdict === 'OPPORTUNITY');

  if (strong.length) {
    for (const c of strong) {
      bullets.push(`HIGH-PROBABILITY SETUP: "${c.name}" — ${c.win_rate}% win rate with average ${c.avg_move} pip moves across ${c.samples} occurrences. When you see ${c.condition}, enter with full conviction.`);
    }
  }

  if (opps.length) {
    for (const c of opps) {
      bullets.push(`OPPORTUNITY: "${c.name}" — ${c.win_rate}% win rate, ${c.avg_move} pip average move. ${c.win_rate >= 55 ? 'Solid edge worth trading with standard size.' : 'Edge present but moderate — consider reduced position size.'}`);
    }
  }

  // Best overall combo
  const best = combos.reduce((a, b) => (b.win_rate > (a?.win_rate || 0)) ? b : a, null);
  if (best && best.win_rate >= 55) {
    bullets.push(`Your single best setup is "${best.name}" at ${best.win_rate}% win rate. If you traded only this pattern, you would have a significant edge over the market.`);
  }

  // Compare combos to see if stacking matters
  if (combos.length >= 2) {
    const avgRate = Math.round(combos.reduce((s, c) => s + c.win_rate, 0) / combos.length);
    bullets.push(`Across all ${combos.length} condition combinations, the average win rate is ${avgRate}%. ${avgRate >= 55 ? 'The engine is finding genuine edges in the market structure.' : 'Some patterns show promise but need more filtering for consistent profitability.'}`);
  }

  const summary = strong.length
    ? `${strong.length} high-probability entry pattern(s) identified. These are the specific market conditions where NervaFX signals have the strongest historical edge.`
    : `${combos.length} condition patterns analyzed. ${opps.length ? 'Opportunities exist but require careful position sizing.' : 'More data needed for definitive conclusions.'}`;

  return { summary, bullets };
}

// ── Move distance ──

function interpretDistance(data) {
  if (!data || !Object.keys(data).length) return { summary: 'Not enough data to analyze move distances.', bullets: [] };

  const bullets = [];
  const horizons = Object.keys(data).sort();

  // 4H is the key trading horizon
  const h4 = data.h4;
  if (h4) {
    bullets.push(`At the 4-hour mark, price moves an average of ${h4.overall_avg_max} pips from entry. Your take-profit should be calibrated around this — setting TP beyond ${Math.round(h4.overall_avg_max * 1.3)} pips means most trades won't reach target.`);
    if (h4.high_energy.samples >= 10 && h4.low_energy.samples >= 10) {
      const ratio = (h4.high_energy.avg_max / Math.max(1, h4.low_energy.avg_max)).toFixed(1);
      bullets.push(`High-energy markets move ${ratio}x further than low-energy markets at 4H (${h4.high_energy.avg_max}p vs ${h4.low_energy.avg_max}p). This is why energy level should directly scale your TP target.`);
    }
  }

  // 8H for swing context
  const h8 = data.h8;
  if (h8) {
    bullets.push(`Over 8 hours, average maximum excursion is ${h8.overall_avg_max} pips. ${h8.overall_avg_net < h8.overall_avg_max * 0.5 ? 'But only ' + h8.overall_avg_net + ' pips net — meaning price retraces significantly. Consider trailing stops rather than fixed TP for longer holds.' : 'Net move of ' + h8.overall_avg_net + ' pips shows strong directional follow-through at this horizon.'}`);
  }

  // 1H for stop loss calibration
  const h1 = data.h1;
  if (h1) {
    bullets.push(`In the first hour, price swings ${h1.overall_avg_max} pips on average. Your stop loss needs to accommodate at least ${Math.round(h1.overall_avg_max * 1.2)} pips to avoid being stopped out by normal noise before the trade can work.`);
  }

  // Energy scaling summary
  if (h4 && h4.high_energy.samples >= 10) {
    const scales = [];
    if (h4.low_energy.avg_max > 0) scales.push(`Low energy: ~${h4.low_energy.avg_max}p`);
    if (h4.mid_energy.avg_max > 0) scales.push(`Mid energy: ~${h4.mid_energy.avg_max}p`);
    if (h4.high_energy.avg_max > 0) scales.push(`High energy: ~${h4.high_energy.avg_max}p`);
    if (scales.length >= 2) {
      bullets.push(`TP scale by energy level (4H): ${scales.join(' → ')}. Use these as your TP targets based on current market energy.`);
    }
  }

  const summary = h4
    ? `Price typically moves ${h4.overall_avg_max} pips maximum within 4 hours. Use this as your baseline for take-profit placement, scaled by market energy level.`
    : 'Move distance analysis shows expected pip ranges at multiple time horizons.';

  return { summary, bullets };
}

// ── Session performance ──

function interpretSessions(data) {
  if (!data || !Object.keys(data).length) return { summary: 'Not enough data to analyze session performance.', bullets: [] };

  const bullets = [];
  const sorted = Object.entries(data).sort((a, b) => b[1].h4_avg_move - a[1].h4_avg_move);

  // Best session
  const best = sorted[0];
  if (best) {
    bullets.push(`${best[0].replace('_', ' ')} is your highest-opportunity session with ${best[1].h4_avg_move} pip average 4H moves and ${best[1].avg_energy} average energy. This is when the market delivers the most tradeable setups.`);
  }

  // Worst session
  const worst = sorted[sorted.length - 1];
  if (worst && worst[1].h4_avg_move < best[1].h4_avg_move * 0.7) {
    bullets.push(`${worst[0].replace('_', ' ')} produces ${worst[1].h4_avg_move} pip 4H moves — ${Math.round((1 - worst[1].h4_avg_move / best[1].h4_avg_move) * 100)}% less than ${best[0].replace('_', ' ')}. ${worst[1].avg_energy < 25 ? 'Low energy during this session makes entries high-risk.' : 'Consider tighter stops during this session.'}`);
  }

  // London/NY overlap
  const overlap = data['LONDON_NY'];
  if (overlap) {
    bullets.push(`London–New York overlap: ${overlap.h4_avg_move} pip 4H moves at ${overlap.avg_energy} avg energy. ${overlap.avg_energy >= 40 ? 'This session overlap generates the most liquid and directional conditions — ideal for trend continuation trades.' : 'Energy levels are moderate. Be selective during this session.'}`);
  }

  // Asia session
  const asia = data['ASIA'];
  if (asia) {
    bullets.push(`Asian session: ${asia.h4_avg_move} pip 4H moves. ${asia.avg_energy < 25 ? 'Low energy typically means ranging conditions. Consider range-based strategies or simply wait for London open.' : 'Surprisingly active — some pairs move well during Asia. Focus on JPY and AUD crosses.'}`);
  }

  // 8H horizon comparison
  const bestH8 = sorted.reduce((a, b) => (b[1].h8_avg_move > (a?.[1]?.h8_avg_move || 0)) ? b : a, null);
  if (bestH8 && bestH8[1].h8_avg_move > 0) {
    bullets.push(`For swing trades (8H+), ${bestH8[0].replace('_', ' ')} entries travel furthest: ${bestH8[1].h8_avg_move} pips average. Time your swing entries during this session for maximum follow-through.`);
  }

  const summary = best
    ? `${best[0].replace('_', ' ')} is the strongest trading session, producing the largest and most reliable price moves. Plan your highest-conviction entries around this time window.`
    : 'Session analysis shows how price behaviour varies across the trading day.';

  return { summary, bullets };
}

module.exports = { runBacktest, saveBacktestResult, loadCandles, interpretAnalysis };
