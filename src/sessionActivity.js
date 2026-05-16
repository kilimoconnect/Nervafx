'use strict';

/**
 * Session Activity Engine — Steps 4–14
 *
 * Step 4   Normalize:    normalized_move = pair_session_move / rolling-20-session avg
 * Step 5   EMA:          smooth_move = (prev_smooth + normalized_move) / 2
 * Step 6   Movement:     movement_score = clamp(avg(smooth_move) × 50, 0–100)
 * Step 7   Breadth:      active = smooth_move >= 1.0 → breadth_score = active/28 × 100
 * Step 8   Agreement:    aligned active pairs / total active pairs × 100
 * Step 9   Volatility:   normalized session range → volatility_score 0–100
 * Step 10  Acceleration: energy_base delta vs previous session
 * Step 11  Compression:  consecutive compressed session streak
 * Step 12  Market energy: weighted composite × quality multiplier (agreement penalises chaos)
 * Step 13  Expansion readiness: streak + compression + session quality + alignment (separate)
 * Step 14  Energy cycle: DEAD / COMPRESSION / TRANSITION / EXPANSION / EXPLOSIVE / EXHAUSTION
 *
 * DB migration required — new columns in hourly_session_activity:
 *   agreement_score    NUMERIC(5,1)
 *   volatility_score   NUMERIC(5,1)
 *   energy_base        NUMERIC(5,1)
 *   acceleration       NUMERIC(6,1)
 *   compression_streak INTEGER DEFAULT 0
 *   movement_magnitude NUMERIC(6,1)
 *   market_energy      NUMERIC(5,1)
 *   expansion_readiness NUMERIC(5,1)
 *   energy_cycle       VARCHAR(20)
 *
 * New columns in session_performance_summary:
 *   avg_agreement_score    NUMERIC(5,1)
 *   avg_volatility_score   NUMERIC(5,1)
 *   avg_energy_base        NUMERIC(5,1)
 *   avg_acceleration       NUMERIC(6,1)
 *   avg_market_energy      NUMERIC(5,1)
 *   avg_expansion_readiness NUMERIC(5,1)
 *   dominant_cycle         VARCHAR(20)
 *   compression_streak     INTEGER DEFAULT 0
 */

const { supabase }          = require('./supabase');
const { getCurrentSession } = require('./sessionEngine');
const { config }            = require('./config');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round1(v) { return Math.round(v * 10) / 10; }
function arrAvg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ─── Session quality scores (for expansion readiness) ─────────────────────────

const SESSION_QUALITY_SCORE = {
  LOW_LIQUIDITY: 0,
  ASIA:          45,
  LONDON:        80,
  NEW_YORK:      80,
};

// ─── Candle fetch ─────────────────────────────────────────────────────────────

async function fetchHourlyCandles(limit = 300) {
  const byTime = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('market_candles')
      .select('time, high, low, close')
      .eq('instrument', instrument)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Candle fetch ${instrument}: ${error.message}`);
    for (const c of data || []) {
      const t = new Date(c.time).toISOString();
      if (!byTime[t]) byTime[t] = {};
      byTime[t][instrument] = {
        close: parseFloat(c.close),
        high:  parseFloat(c.high),
        low:   parseFloat(c.low),
      };
    }
  }
  return byTime;
}

// ─── Session classification ───────────────────────────────────────────────────

function classifyHour(isoTime) {
  return getCurrentSession(new Date(isoTime)).session;
}

// ─── Currency strength (Step 8) ──────────────────────────────────────────────
// Derived from same session-open candles — no extra DB fetch needed.

const CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

function computeCurrencyStrengths(candles, sessionOpenPrices) {
  const sums  = {}, counts = {};
  for (const ccy of CURRENCIES) { sums[ccy] = 0; counts[ccy] = 0; }
  for (const inst of config.instruments) {
    const [base, quote] = inst.split('_');
    const c    = candles[inst];
    const open = sessionOpenPrices[inst];
    if (!c || !open || open === 0) continue;
    const move = (c.close - open) / open;
    sums[base]  += move;  counts[base]++;
    sums[quote] -= move;  counts[quote]++;
  }
  const strength = {};
  for (const ccy of CURRENCIES) {
    strength[ccy] = counts[ccy] > 0 ? sums[ccy] / counts[ccy] : 0;
  }
  return strength;
}

// ─── Step 14: Energy cycle classification ────────────────────────────────────
// Priority order: DEAD → EXPLOSIVE → EXPANSION → EXHAUSTION → COMPRESSION → TRANSITION → STABLE

// Step 14 — Energy cycle classification
// Priority: DEAD → EXPLOSIVE → EXPANSION → EXHAUSTION → COMPRESSION
//           → PRESSURE_BUILDING → TRANSITION → CONTROLLED → BALANCED
function classifyEnergyCycle(mov, brd, agr, vol, streak, accel, prev) {
  const movRising  = prev ? mov > prev.movement  : false;
  const brdRising  = prev ? brd > prev.breadth   : false;
  const brdFalling = prev ? brd < prev.breadth   : false;
  const agrFalling = prev ? agr < prev.agreement : false;

  if (mov < 20 && brd < 20 && vol < 25)                               return 'DEAD';
  if (mov >= 75 && brd >= 70 && agr >= 70 && vol >= 70)               return 'EXPLOSIVE';
  if (mov >= 60 && brd >= 55 && agr >= 60)                            return 'EXPANSION';
  // EXHAUSTION: all four signs present simultaneously — movement still elevated
  // while breadth AND agreement are both retreating with negative acceleration.
  // Requires all four conditions to avoid false positives.
  if (mov >= 50 && accel < 0 && brdFalling && agrFalling)             return 'EXHAUSTION';
  if (mov < 35 && brd < 35 && vol < 40 && streak >= 1)                return 'COMPRESSION';
  if (streak >= 1 && mov < 50 && brd < 50)                            return 'PRESSURE_BUILDING';
  if (movRising && brdRising)                                          return 'TRANSITION';
  if (agr >= 60 && mov >= 35)                                          return 'CONTROLLED';
  if (mov >= 35 && brd >= 35)                                          return 'BALANCED';
  return 'CONTROLLED';
}

// ─── Core computation engine ──────────────────────────────────────────────────

function processHours(hourKeys, byTime, onlyLast = false) {
  const TOTAL = config.instruments.length; // 28
  const HIST  = 20;

  // Rolling per-pair per-session histories
  const moveHistory  = {}; // inst → session → [final pair_session_move per completed session]
  const rangeHistory = {}; // inst → session → [final session_range per completed session]

  // EMA state
  const pairEma = {}; // inst → session → smooth_move

  // Current session tracking
  let currentSession    = null;
  let sessionOpenPrices = {};
  let sessionHigh       = {};
  let sessionLow        = {};
  let sessionFinalMove  = {};

  // Cross-session carry-over
  let prevEnergyBase    = null;
  let prevSessionScores = null; // { movement, breadth, agreement, volatility } of previous session
  let compressionStreak = 0;

  // Running session accumulators (reset each new session)
  let sessionEBList  = [];
  let sessionMovList = [];
  let sessionBrdList = [];
  let sessionAgrList = [];
  let sessionVolList = [];

  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = classifyHour(hk);

    // ── Session transition ──────────────────────────────────────────────────
    if (session !== currentSession) {
      if (currentSession && currentSession !== 'LOW_LIQUIDITY') {

        // Finalise move + range histories for completed session
        for (const inst of config.instruments) {
          const finalMove = sessionFinalMove[inst];
          if (finalMove != null) {
            if (!moveHistory[inst])                moveHistory[inst]                = {};
            if (!moveHistory[inst][currentSession]) moveHistory[inst][currentSession] = [];
            moveHistory[inst][currentSession].push(finalMove);
            if (moveHistory[inst][currentSession].length > HIST) moveHistory[inst][currentSession].shift();
          }
          const high = sessionHigh[inst];
          const low  = sessionLow[inst];
          const open = sessionOpenPrices[inst];
          if (high != null && low != null && open > 0) {
            const range = (high - low) / open;
            if (!rangeHistory[inst])                rangeHistory[inst]                = {};
            if (!rangeHistory[inst][currentSession]) rangeHistory[inst][currentSession] = [];
            rangeHistory[inst][currentSession].push(range);
            if (rangeHistory[inst][currentSession].length > HIST) rangeHistory[inst][currentSession].shift();
          }
        }

        // Capture session averages before resetting
        const avgMov = arrAvg(sessionMovList);
        const avgBrd = arrAvg(sessionBrdList);
        const avgAgr = arrAvg(sessionAgrList);
        const avgVol = arrAvg(sessionVolList);

        // Step 11: update compression streak
        if (avgMov < 35 && avgBrd < 35 && avgVol < 40) compressionStreak++;
        else compressionStreak = 0;

        // Step 10: carry energy base forward
        if (sessionEBList.length) prevEnergyBase = arrAvg(sessionEBList);

        // Step 14: carry session scores forward for "rising/falling" detection
        prevSessionScores = { movement: avgMov, breadth: avgBrd, agreement: avgAgr, volatility: avgVol };
      }

      // Reset for new session
      sessionOpenPrices = {};
      sessionHigh       = {};
      sessionLow        = {};
      sessionFinalMove  = {};
      sessionEBList     = [];
      sessionMovList    = [];
      sessionBrdList    = [];
      sessionAgrList    = [];
      sessionVolList    = [];

      for (const [inst, c] of Object.entries(candles)) {
        sessionOpenPrices[inst] = c.close;
        sessionHigh[inst]       = c.high;
        sessionLow[inst]        = c.low;
      }
      currentSession = session;
    }

    if (session === 'LOW_LIQUIDITY') continue;

    // ── Update running session high/low ────────────────────────────────────
    for (const [inst, c] of Object.entries(candles)) {
      if (c.high != null && (sessionHigh[inst] == null || c.high > sessionHigh[inst])) sessionHigh[inst] = c.high;
      if (c.low  != null && (sessionLow[inst]  == null || c.low  < sessionLow[inst]))  sessionLow[inst]  = c.low;
    }

    // ── Currency strength (Step 8) ──────────────────────────────────────────
    const ccyStrength = computeCurrencyStrengths(candles, sessionOpenPrices);

    // ── Currency dispersion (for dominance — computed after ccyStrength) ───────
    // Dominance is finalised after breadthScore + rawAgreementRatio are known.
    let strongestCcy = null, weakestCcy = null, _dispersion = 0;
    {
      const sorted = Object.entries(ccyStrength).sort((a, b) => b[1] - a[1]);
      if (sorted.length) {
        strongestCcy  = sorted[0][0];
        weakestCcy    = sorted[sorted.length - 1][0];
        _dispersion   = sorted[0][1] - sorted[sorted.length - 1][1]; // max − min
      }
    }

    // ── Per-pair calculations (Steps 3–9) ──────────────────────────────────
    const smoothMoveVals   = [];
    const normalizedRanges = [];
    let alignedActive = 0, totalActive = 0;
    let bullish = 0, bearish = 0;

    for (const inst of config.instruments) {
      const c    = candles[inst];
      const open = sessionOpenPrices[inst];
      if (!c || open == null || open === 0) continue;

      // Step 3: raw pair session move
      const rawDir  = (c.close - open) / open;
      const rawMove = Math.abs(rawDir);
      sessionFinalMove[inst] = rawMove;
      if (rawDir > 0) bullish++; else if (rawDir < 0) bearish++;

      // Step 4: normalize against rolling-20 avg
      const mhist  = moveHistory[inst]?.[session] || [];
      const mhAvg  = mhist.length > 0 ? arrAvg(mhist) : rawMove;
      const normMov = mhAvg > 0 ? rawMove / mhAvg : 1.0;

      // Step 5: EMA smooth (α = 0.5)
      if (!pairEma[inst]) pairEma[inst] = {};
      const prevEma    = pairEma[inst][session] ?? normMov;
      const smoothMove = (prevEma + normMov) / 2;
      pairEma[inst][session] = smoothMove;
      smoothMoveVals.push(smoothMove);

      // Step 8: directional agreement (active pairs only)
      if (smoothMove >= 1.0) {
        totalActive++;
        const [base, quote] = inst.split('_');
        const expectedDir   = (ccyStrength[base] || 0) - (ccyStrength[quote] || 0);
        if ((expectedDir > 0 && rawDir > 0) || (expectedDir < 0 && rawDir < 0)) alignedActive++;
      }

      // Step 9: session range normalized
      const high = sessionHigh[inst], low = sessionLow[inst];
      if (high != null && low != null) {
        const range = (high - low) / open;
        const rhist = rangeHistory[inst]?.[session] || [];
        const rhAvg = rhist.length > 0 ? arrAvg(rhist) : range;
        normalizedRanges.push(rhAvg > 0 ? range / rhAvg : 1.0);
      }
    }

    if (!smoothMoveVals.length) continue;

    // Step 6: movement score
    const moveMagnitude  = arrAvg(smoothMoveVals);
    const movementScore  = round1(Math.min(100, moveMagnitude * 50));

    // Step 7: breadth score
    const activePairs  = smoothMoveVals.filter(m => m >= 1.0).length;
    const breadthScore = round1((activePairs / TOTAL) * 100);

    // Step 8: agreement score — weighted by participation to prevent inflation.
    // Raw ratio from a tiny active sample (e.g. 5 pairs) produces misleadingly
    // high agreement. Multiplying by sqrt(breadth/100) penalises low participation:
    //   breadth=18%, raw=86% → effective = 86 × sqrt(0.18) ≈ 36
    //   breadth=70%, raw=86% → effective = 86 × sqrt(0.70) ≈ 72
    const rawAgreementRatio = totalActive > 0 ? alignedActive / totalActive : 0;
    const agreementScore    = round1(rawAgreementRatio * Math.sqrt(breadthScore / 100) * 100);

    // Dominance: dispersion × participation × agreement → clean directional market.
    // High dispersion with low breadth = weak signal; broad participation required.
    // Normalised to 0–100 (reference dispersion 1% = 0.010 as full scale).
    const dominanceScore = round1(Math.min(100,
      (_dispersion / 0.010) * (breadthScore / 100) * rawAgreementRatio * 100
    ));

    // Step 9: volatility score
    const volatilityScore = normalizedRanges.length > 0
      ? round1(Math.min(100, arrAvg(normalizedRanges) * 50))
      : 0;

    // Step 10: energy base and acceleration
    const energyBase   = round1(0.45 * movementScore + 0.35 * breadthScore + 0.20 * volatilityScore);
    const acceleration = prevEnergyBase != null ? round1(energyBase - prevEnergyBase) : 0;

    // Step 12: final market energy (agreement acts as quality multiplier — punishes chaos)
    const rawEnergy    = 0.40 * movementScore + 0.30 * breadthScore + 0.20 * agreementScore + 0.10 * volatilityScore;
    const qualityMult  = 0.5 + agreementScore / 200; // 0.5 (agr=0) → 1.0 (agr=100)
    const marketEnergy = round1(Math.min(100, rawEnergy * qualityMult));

    // Step 12b: compression score stored for history (not used in readiness formula)
    const compressionScore = round1(((100 - movementScore) * (100 - breadthScore)) / 100);

    // Step 13: expansion readiness — designed to LEAD energy, not follow it.
    // Key: energyPressure = 100 − marketEnergy.
    //   During COMPRESSION: energy is low → energyPressure high → readiness elevated.
    //   During EXPANSION:   energy is high → energyPressure low → readiness falls.
    //   accelScore peaks at TRANSITION (waking signal) then tapers.
    // Result: readiness peaks at COMPRESSION/TRANSITION and drops into EXPANSION.
    const streakScore    = Math.min(100, compressionStreak * 25);
    const energyPressure = Math.max(0, 100 - marketEnergy); // inverse of energy level
    const sessQualScore  = SESSION_QUALITY_SCORE[session] || 50;
    const accelScore     = Math.min(100, Math.max(0, 50 + acceleration * 2));
    const expansionReadiness = round1(Math.min(100,
      0.35 * streakScore    // compression persistence — main driver
      + 0.25 * energyPressure // potential energy (high when market suppressed)
      + 0.20 * accelScore   // waking signal — peaks at transition
      + 0.10 * sessQualScore // session quality bonus
      + 0.10 * agreementScore // directional organization
    ));

    // Step 14: energy cycle classification
    const energyCycle = classifyEnergyCycle(
      movementScore, breadthScore, agreementScore, volatilityScore,
      compressionStreak, acceleration, prevSessionScores
    );

    // Accumulate session lists for boundary calculations
    sessionEBList.push(energyBase);
    sessionMovList.push(movementScore);
    sessionBrdList.push(breadthScore);
    sessionAgrList.push(agreementScore);
    sessionVolList.push(volatilityScore);

    rows.push({
      time_utc:             hk,
      session_name:         session,
      // Component scores
      movement_score:       movementScore,
      breadth_score:        breadthScore,
      agreement_score:      agreementScore,
      volatility_score:     volatilityScore,
      // Derived
      energy_base:          energyBase,
      acceleration:         acceleration,
      compression_score:    compressionScore,
      expansion_score:      round1((movementScore * breadthScore) / 100),
      // Final outputs
      market_energy:        marketEnergy,
      expansion_readiness:  expansionReadiness,
      energy_cycle:         energyCycle,
      // Persistence
      compression_streak:   compressionStreak,
      // Pair stats
      pairs_moving:         activePairs,
      pairs_quiet:          TOTAL - activePairs,
      movement_magnitude:   round1(moveMagnitude * 100),
      // Directional + dominance — NOT columns in hourly_session_activity; session aggregation only
      bullish_breadth:      round1((bullish / TOTAL) * 100),
      bearish_breadth:      round1((bearish / TOTAL) * 100),
      dominance_score:      dominanceScore,
      strongest_ccy:        strongestCcy,
      weakest_ccy:          weakestCcy,
      // Backward compat alias
      directional_agreement: agreementScore,
    });
  }

  return onlyLast ? rows.slice(-1) : rows;
}

// ─── Hourly upsert column filter ─────────────────────────────────────────────
// bullish_breadth / bearish_breadth are in-memory only — not columns in
// hourly_session_activity. Strip them before upserting to that table.

// Most-frequent value in an array (used for currency labels across session hours)
function _modal(arr) {
  if (!arr.length) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Fields that exist as columns in hourly_session_activity.
// bullish_breadth / bearish_breadth / dominance_score / strongest_ccy / weakest_ccy
// are computed in-memory and aggregated at session level only — not stored hourly.
const HOURLY_COLS = new Set([
  'time_utc', 'session_name',
  'movement_score', 'breadth_score', 'agreement_score', 'volatility_score',
  'energy_base', 'acceleration', 'compression_score', 'expansion_score',
  'market_energy', 'expansion_readiness', 'energy_cycle',
  'compression_streak', 'pairs_moving', 'pairs_quiet',
  'movement_magnitude', 'directional_agreement',
]);

function toHourlyRow(r) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => HOURLY_COLS.has(k)));
}

// ─── Step 15: Build per-session rows for market_energy_sessions ──────────────

function buildSessionRows(hourRows) {
  const groups = {};
  for (const r of hourRows) {
    const date = r.time_utc.slice(0, 10);
    const key  = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, rows: [] };
    groups[key].rows.push(r);
  }

  return Object.values(groups).map(g => {
    const n   = field => g.rows.map(r => parseFloat(r[field]) || 0);
    const avg = arr   => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const cycleCounts = {};
    for (const r of g.rows) {
      const c = r.energy_cycle || 'BALANCED';
      cycleCounts[c] = (cycleCounts[c] || 0) + 1;
    }
    const dominantCycle = Object.entries(cycleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'BALANCED';

    const firstRow = g.rows[0];
    const lastRow  = g.rows[g.rows.length - 1];

    const sessionStart = new Date(firstRow.time_utc);
    const sessionEnd   = new Date(lastRow.time_utc);
    sessionEnd.setUTCHours(sessionEnd.getUTCHours() + 1);

    return {
      session_date:        g.date,
      session_name:        g.session,
      session_zone:        null,
      session_start:       sessionStart.toISOString(),
      session_end:         sessionEnd.toISOString(),
      movement_score:      round1(avg(n('movement_score'))),
      breadth_score:       round1(avg(n('breadth_score'))),
      agreement_score:     round1(avg(n('agreement_score'))),
      volatility_score:    round1(avg(n('volatility_score'))),
      acceleration_score:  round1(avg(n('acceleration'))),
      compression_score:   round1(avg(n('compression_score'))),
      compression_streak:  lastRow.compression_streak || 0,
      expansion_readiness: round1(avg(n('expansion_readiness'))),
      market_energy:       round1(avg(n('market_energy'))),
      energy_cycle:        dominantCycle,
      active_pairs:        Math.round(avg(n('pairs_moving'))),
      aligned_pairs:       null,
      bullish_breadth:     round1(avg(n('bullish_breadth'))),
      bearish_breadth:     round1(avg(n('bearish_breadth'))),
      dominance_score:     round1(avg(n('dominance_score'))),
      strongest_ccy:       _modal(g.rows.map(r => r.strongest_ccy).filter(Boolean)),
      weakest_ccy:         _modal(g.rows.map(r => r.weakest_ccy).filter(Boolean)),
      details: {
        hours: g.rows.length,
        hourly: g.rows.map(r => ({
          time:                r.time_utc,
          energy_cycle:        r.energy_cycle,
          market_energy:       r.market_energy,
          expansion_readiness: r.expansion_readiness,
        })),
      },
    };
  });
}

async function upsertMarketEnergySessions(sessionRows) {
  if (!sessionRows.length) return;
  const { error } = await supabase
    .from('market_energy_sessions')
    .upsert(sessionRows, { onConflict: 'session_date,session_name', ignoreDuplicates: false });
  if (error) throw new Error(`market_energy_sessions upsert: ${error.message}`);
  console.log(`[SESSION_ACTIVITY] ${sessionRows.length} market_energy_sessions rows stored.`);
}

// ─── Session summaries ────────────────────────────────────────────────────────

async function computeSessionSummaries() {
  const { data: rawRows, error } = await supabase
    .from('hourly_session_activity')
    .select([
      'time_utc', 'session_name',
      'movement_score', 'breadth_score', 'agreement_score', 'volatility_score',
      'energy_base', 'acceleration', 'market_energy', 'expansion_readiness',
      'energy_cycle', 'compression_streak', 'pairs_moving', 'expansion_score',
    ].join(', '))
    .order('time_utc', { ascending: true });
  if (error || !rawRows?.length) return;

  const groups = {};
  for (const r of rawRows) {
    const date = r.time_utc.slice(0, 10);
    if (new Date(date).getUTCDay() % 6 === 0) continue;
    const key = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, hrs: [] };
    groups[key].hrs.push(r);
  }

  const sortedKeys     = Object.keys(groups).sort();
  const sessionHistory = {};

  const summaries = sortedKeys.map(key => {
    const g   = groups[key];
    const num = field => g.hrs.map(h => parseFloat(h[field]) || 0);

    const movements = num('movement_score');
    const breadths  = num('breadth_score');
    const agrs      = num('agreement_score');
    const vols      = num('volatility_score');
    const ebs       = num('energy_base');
    const accels    = num('acceleration');
    const energies  = num('market_energy');
    const readiness = num('expansion_readiness');
    const movingN   = g.hrs.map(h => parseInt(h.pairs_moving) || 0);

    const avgMov     = arrAvg(movements);
    const avgBrd     = arrAvg(breadths);
    const avgAgr     = arrAvg(agrs);
    const avgVol     = arrAvg(vols);
    const avgEB      = arrAvg(ebs);
    const avgAcc     = arrAvg(accels);
    const avgEnergy  = arrAvg(energies);
    const avgReady   = arrAvg(readiness);

    // Expansion component vs last-10 same-session history (for session_energy_score)
    const hist    = sessionHistory[g.session] || [];
    const histAvg = hist.slice(-10).length > 0 ? arrAvg(hist.slice(-10)) : avgMov;
    const expComp = round1(Math.min(100, (histAvg > 0 ? avgMov / histAvg : 1.0) * 50));
    if (!sessionHistory[g.session]) sessionHistory[g.session] = [];
    sessionHistory[g.session].push(avgMov);

    // Legacy energy score (for existing code that reads session_energy_score)
    const energyScore = Math.min(100, Math.round(
      0.40 * avgMov + 0.35 * avgBrd + 0.15 * expComp + 0.10 * avgAgr
    ));
    let energyState = energyScore <= 15 ? 'DEAD'
                    : energyScore <= 35 ? 'COMPRESSION'
                    : energyScore <= 55 ? 'STABLE'
                    : energyScore <= 75 ? 'EXPANSION' : 'EXPLOSIVE';
    if (avgBrd < 50 && (energyState === 'EXPANSION' || energyState === 'EXPLOSIVE')) energyState = 'STABLE';

    // Dominant energy cycle for this session
    const cycleCounts = {};
    for (const h of g.hrs) {
      const c = h.energy_cycle || 'STABLE';
      cycleCounts[c] = (cycleCounts[c] || 0) + 1;
    }
    const dominantCycle = Object.entries(cycleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'STABLE';

    const maxStreak = g.hrs.reduce((m, h) => Math.max(m, parseInt(h.compression_streak) || 0), 0);

    return {
      session_date_utc:          g.date,
      session_name:              g.session,
      // Component averages
      avg_movement_score:        round1(avgMov),
      avg_breadth_score:         round1(avgBrd),
      avg_directional_agreement: round1(avgAgr),
      avg_agreement_score:       round1(avgAgr),
      avg_volatility_score:      round1(avgVol),
      avg_energy_base:           round1(avgEB),
      avg_acceleration:          round1(avgAcc),
      // Final energy outputs
      avg_market_energy:         round1(avgEnergy),
      avg_expansion_readiness:   round1(avgReady),
      // Legacy
      expansion_score:           expComp,
      session_energy_score:      energyScore,
      session_state:             energyState,
      // Cycle
      dominant_cycle:            dominantCycle,
      // Stats
      pairs_moving_avg:          round1(arrAvg(movingN)),
      expansion_hours:           g.hrs.filter(h => parseFloat(h.expansion_score) >= 40).length,
      compression_hours:         g.hrs.filter(h => parseFloat(h.expansion_score) <  20).length,
      compression_streak:        maxStreak,
      hour_count:                g.hrs.length,
    };
  });

  if (!summaries.length) return;
  const { error: e } = await supabase
    .from('session_performance_summary')
    .upsert(summaries, { onConflict: 'session_date_utc,session_name', ignoreDuplicates: false });
  if (e) throw new Error(`Summary upsert: ${e.message}`);
  console.log(`[SESSION_ACTIVITY] ${summaries.length} summaries stored.`);
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function backfillSessionActivity() {
  console.log('[SESSION_ACTIVITY] Backfill: fetching candles…');
  const byTime   = await fetchHourlyCandles(300);
  const hourKeys = Object.keys(byTime).sort();
  if (!hourKeys.length) { console.log('[SESSION_ACTIVITY] No candles.'); return; }

  const rows = processHours(hourKeys, byTime);
  if (!rows.length) return;

  const { error } = await supabase
    .from('hourly_session_activity')
    .upsert(rows.map(toHourlyRow), { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) throw new Error(`Hourly upsert: ${error.message}`);
  console.log(`[SESSION_ACTIVITY] Backfilled ${rows.length} rows.`);

  await upsertMarketEnergySessions(buildSessionRows(rows));
  await computeSessionSummaries();
  return { rows: rows.length };
}

// ─── Incremental ──────────────────────────────────────────────────────────────

async function calculateLatestSessionActivity() {
  const byTime   = await fetchHourlyCandles(300);
  const hourKeys = Object.keys(byTime).sort();
  if (hourKeys.length < 2) return;

  // Full compute — need all rows to build accurate session aggregates
  const allRows = processHours(hourKeys, byTime);
  const row = allRows[allRows.length - 1];
  if (!row) return;

  // Upsert the latest hourly row (strip in-memory-only fields)
  const { error } = await supabase
    .from('hourly_session_activity')
    .upsert([toHourlyRow(row)], { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) throw new Error(`Hourly upsert: ${error.message}`);

  // Upsert current + recent sessions (last 4 to cover today's full cycle)
  const sessionRows = buildSessionRows(allRows);
  await upsertMarketEnergySessions(sessionRows.slice(-4));

  console.log(
    `[SESSION_ACTIVITY] ✓ ${row.time_utc} | ${row.session_name} | ${row.energy_cycle}` +
    ` | energy:${row.market_energy} ready:${row.expansion_readiness}` +
    ` | mov:${row.movement_score} brd:${row.breadth_score} agr:${row.agreement_score} vol:${row.volatility_score}` +
    ` | acc:${row.acceleration >= 0 ? '+' : ''}${row.acceleration} streak:${row.compression_streak}`
  );

  await computeSessionSummaries();
  return row;
}

module.exports = { backfillSessionActivity, calculateLatestSessionActivity, computeSessionSummaries };
