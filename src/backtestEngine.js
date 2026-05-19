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

module.exports = { runBacktest, saveBacktestResult, loadCandles };
