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
    energy_thresholds:    interpretEnergy(analysis.energy_thresholds),
    strength_thresholds:  interpretStrength(analysis.strength_thresholds),
    state_outcomes:       interpretStates(analysis.state_outcomes),
    no_trade_zones:       interpretNoTrade(analysis.no_trade_zones),
    condition_combos:     interpretCombos(analysis.condition_combos),
    move_distance:        interpretDistance(analysis.move_distance),
    session_performance:  interpretSessions(analysis.session_performance),
  };
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
