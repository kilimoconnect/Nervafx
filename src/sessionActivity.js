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
function ri(v)     { return Math.round(parseFloat(v) || 0); }
function arrAvg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function pctVsRef(current, ref) {
  if (!ref) return null;
  const pct = Math.round((current / ref - 1) * 100);
  return Math.abs(pct) > 200 ? null : pct;
}

function avgField(arr, field) {
  if (!arr.length) return 0;
  return arr.reduce((s, row) => s + (parseFloat(row[field]) || 0), 0) / arr.length;
}

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
// 7-state lifecycle: DEAD → LOW_PARTICIPATION → COMPRESSION → TRANSITION
//                            → EXPANSION → EXPLOSIVE → EXHAUSTION
// Each state is mutually exclusive and ordered by priority.
// Session-specific thresholds: Asia naturally runs quieter than London/NY.

// Thresholds calibrated to each session's typical activity range.
// Asia is structurally quieter (7-9 active pairs typical) than London/NY (12-18).
// COMPRESSION drops the vol requirement — breadth can collapse while vol stays
// elevated (a few pairs making large moves), which is still compression.
const SESS_PROFILE = {
  ASIA: {
    // Historical avg: mov≈34, brd≈24, agr≈35 — thresholds set so average = EXPANSION
    deadMov: 10, deadBrd:  8, deadVol: 12,
    exMov:   52, exBrd:   42, exAgr:   48,   // EXPLOSIVE
    expMov:  28, expBrd:  18, expAgr:  24,   // EXPANSION
    exhMov:  28,
    trBrd:   14, trAgr:   20, trMov:   18,   // TRANSITION
    cmpBrd:  14,                              // COMPRESSION (breadth-only gate)
  },
  LONDON: {
    // Historical avg: mov≈50, brd≈47, agr≈42 — current session is below average
    deadMov: 15, deadBrd: 12, deadVol: 18,
    exMov:   68, exBrd:   62, exAgr:   62,
    expMov:  42, expBrd:  35, expAgr:  36,
    exhMov:  42,
    trBrd:   22, trAgr:   30, trMov:   28,
    cmpBrd:  22,
  },
  NEW_YORK: {
    // Historical avg: mov≈58, brd≈44, agr≈40 — current session is well below average
    deadMov: 15, deadBrd: 12, deadVol: 18,
    exMov:   72, exBrd:   65, exAgr:   65,
    expMov:  48, expBrd:  38, expAgr:  38,
    exhMov:  48,
    trBrd:   24, trAgr:   30, trMov:   32,
    cmpBrd:  24,
  },
  DEFAULT: {
    deadMov: 20, deadBrd: 20, deadVol: 25,
    exMov:   75, exBrd:   70, exAgr:   70,
    expMov:  50, expBrd:  45, expAgr:  45,
    exhMov:  50,
    trBrd:   35, trAgr:   45, trMov:   30,
    cmpBrd:  35,
  },
};

function classifyEnergyCycle(mov, brd, agr, vol, streak, accel, prev, session) {
  const p = SESS_PROFILE[session] || SESS_PROFILE.DEFAULT;
  const movRising  = prev ? mov > prev.movement : false;
  const brdRising  = prev ? brd > prev.breadth  : false;
  const brdFalling = prev ? brd < prev.breadth  : false;

  if (mov < p.deadMov && brd < p.deadBrd && vol < p.deadVol)                      return 'DEAD';
  if (mov >= p.exMov  && brd >= p.exBrd  && agr >= p.exAgr)                       return 'EXPLOSIVE';
  if (mov >= p.exhMov && accel < 0 && brdFalling)                                 return 'EXHAUSTION';
  if (mov >= p.expMov && brd >= p.expBrd && agr >= p.expAgr)                      return 'EXPANSION';
  if (movRising && brdRising && accel > 0 && brd > p.trBrd && agr > p.trAgr && mov >= p.trMov)
    return 'TRANSITION';
  if (brd < p.cmpBrd && streak >= 1)                                               return 'COMPRESSION';
  return 'LOW_PARTICIPATION';
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

  // Per-session-type carry-over (Asia vs Asia, London vs London, NY vs NY)
  const prevSameSessionEnergy = {}; // session_name → avg energy base of previous same-session occurrence
  const prevSameSessionScores = {}; // session_name → { movement, breadth, agreement, volatility }
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

        // Step 10: carry energy base forward (same-session only)
        if (sessionEBList.length) prevSameSessionEnergy[currentSession] = arrAvg(sessionEBList);

        // Step 14: store per-session scores so Asia compares against previous Asia (not NY)
        prevSameSessionScores[currentSession] = { movement: avgMov, breadth: avgBrd, agreement: avgAgr, volatility: avgVol };
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
    // Magnitude-weighted pressure: sum of smoothMove per direction.
    // More scientifically correct than counting pairs — 3 pairs moving 2× avg
    // outweighs 10 pairs barely moving.
    let bullishMagnitude = 0, bearishMagnitude = 0;

    for (const inst of config.instruments) {
      const c    = candles[inst];
      const open = sessionOpenPrices[inst];
      if (!c || open == null || open === 0) continue;

      // Step 3: raw pair session move
      const rawDir  = (c.close - open) / open;
      const rawMove = Math.abs(rawDir);
      sessionFinalMove[inst] = rawMove;

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

      // Accumulate directional magnitude across ALL pairs with any movement
      if (rawDir > 0) bullishMagnitude += smoothMove;
      else if (rawDir < 0) bearishMagnitude += smoothMove;

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

    // Magnitude-weighted directional pressure: % of total smoothMove on each side.
    // bull=62% means 62% of all pair movement is bullish in nature.
    // Dominance = how skewed that split is (bull=75%, bear=25% → dominance 50%).
    const totalMagnitude    = bullishMagnitude + bearishMagnitude;
    const bullishPressurePct = totalMagnitude > 0
      ? round1(bullishMagnitude / totalMagnitude * 100) : 50;
    const bearishPressurePct = totalMagnitude > 0
      ? round1(bearishMagnitude / totalMagnitude * 100) : 50;
    const dominanceScore = totalMagnitude > 0
      ? round1(Math.abs(bullishMagnitude - bearishMagnitude) / totalMagnitude * 100)
      : 0;

    // Step 9: volatility score
    const volatilityScore = normalizedRanges.length > 0
      ? round1(Math.min(100, arrAvg(normalizedRanges) * 50))
      : 0;

    // Step 10: energy base and acceleration (same-session: Asia vs Asia, London vs London, NY vs NY)
    const energyBase   = round1(0.45 * movementScore + 0.35 * breadthScore + 0.20 * volatilityScore);
    const prevSessEB   = prevSameSessionEnergy[session] ?? null;
    const acceleration = prevSessEB != null ? round1(energyBase - prevSessEB) : 0;

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
      compressionStreak, acceleration, prevSameSessionScores[session] || null, session
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
      // Directional pressure (magnitude-weighted) — NOT columns in hourly_session_activity
      // bullish_breadth / bearish_breadth now store % of total movement magnitude per side
      bullish_breadth:      bullishPressurePct,
      bearish_breadth:      bearishPressurePct,
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

// ─── Market energy analysis (in-memory — no DB re-read required) ─────────────

const SESSION_ORDER    = ['ASIA', 'LONDON', 'NEW_YORK', 'LOW_LIQUIDITY'];
const SESS_LABEL       = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
const SESS_NEXT        = { ASIA: 'LONDON', LONDON: 'NEW_YORK', NEW_YORK: 'ASIA' };
const COMPRESSED_CYCLE = new Set(['DEAD', 'COMPRESSION', 'LOW_PARTICIPATION']);

function buildFlowNarrative(carryOver) {
  if (!carryOver || carryOver.length < 2) return null;

  const comp  = c => COMPRESSED_CYCLE.has(c);
  const exp   = c => c === 'EXPANSION' || c === 'EXPLOSIVE';
  const trans = c => c === 'TRANSITION';

  const n        = carryOver.length;
  const last     = carryOver[n - 1];
  const prev     = carryOver[n - 2];
  const energies = carryOver.map(c => c.energy);
  const sessions = carryOver.map(c => c.session);
  const cycles   = carryOver.map(c => c.cycle);

  const eStart    = energies[0];
  const eLast     = energies[n - 1];
  const ePeak     = Math.max(...energies);
  const peakIdx   = energies.lastIndexOf(ePeak);
  const peakSess  = sessions[peakIdx];

  const allComp   = cycles.every(comp);
  const wasPeaked = exp(cycles[peakIdx]) && peakIdx < n - 1;
  const risingNow = eLast > prev.energy + 3;
  const fallingNow= eLast < prev.energy - 3;
  const stateOf   = c => (c || '').toLowerCase().replace(/_/g, ' ');
  const avgE      = Math.round(energies.reduce((a, b) => a + b, 0) / n);

  if (wasPeaked && comp(last.cycle)) {
    return `${peakSess} expansion (energy ${ePeak}) has weakened into ${last.session} ${stateOf(last.cycle)} — energy retreated to ${eLast}. No directional pressure developing in the current session.`;
  }
  if (allComp && risingNow) {
    return `Compression persisting through ${sessions.slice(0, -1).join(', ')}, with mild energy accumulation into ${last.session} (${eStart} → ${eLast}). Conditions approaching inflection but breadth remains suppressed.`;
  }
  if (allComp) {
    return `Participation remains broadly suppressed — energy averaged ${avgE} across ${sessions.join(', ')}. No structural shift in session flow detected.`;
  }
  if (exp(last.cycle) && eLast > eStart) {
    return `Energy building from ${eStart} to ${eLast} through ${sessions.join(' → ')} — ${last.session} showing ${stateOf(last.cycle)} conditions with broad directional follow-through.`;
  }
  if (trans(last.cycle)) {
    return `${prev.session} ${stateOf(prev.cycle)} giving way to early ${last.session} movement (energy ${eLast}, breadth ${last.breadth}%). Transition structure forming — not yet confirmed.`;
  }
  if (fallingNow) {
    return `Energy declining from ${eStart} to ${eLast} — ${last.session} ${stateOf(last.cycle)} as participation contracts. Session flow suggests caution on directional exposure.`;
  }
  const trend = eLast > eStart + 5 ? 'gaining ground' : eLast < eStart - 5 ? 'losing ground' : 'holding flat';
  return `Mixed session flow across ${sessions.join(' → ')} — energy ${trend} (${eStart} → ${eLast}), currently ${stateOf(last.cycle)} in ${last.session}.`;
}

function classifyMarketCycle(sequence) {
  if (!sequence.length) return null;

  const recent   = sequence.slice(-4);
  const cycles   = recent.map(s => s.energy_cycle);
  const energies = recent.map(s => parseFloat(s.market_energy) || 0);
  const eLast    = energies[energies.length - 1];
  const eFirst   = energies[0];
  const eTrend   = eLast - eFirst;
  const avgE     = energies.reduce((a, b) => a + b, 0) / energies.length;

  const comp  = c => COMPRESSED_CYCLE.has(c);
  const exp   = c => c === 'EXPANSION' || c === 'EXPLOSIVE';
  const lastC = cycles[cycles.length - 1];

  const recentAllComp = cycles.slice(-2).every(comp);
  const anyExp        = cycles.some(exp);
  const nowExp        = exp(lastC);
  const nowTrans      = lastC === 'TRANSITION';
  const nowExhaust    = lastC === 'EXHAUSTION';

  if (nowExhaust)                        return 'CYCLE_EXHAUSTION';
  if (nowExp && eTrend >= 0)             return 'ACTIVE_EXPANSION';
  if (anyExp && recentAllComp)           return 'POST_EXPANSION_RESET';
  if (nowTrans && eTrend > 0)            return 'TRANSITION_BUILD_UP';
  if (recentAllComp && avgE < 20)        return 'DEEP_COMPRESSION';
  if (recentAllComp)                     return 'LOW_PARTICIPATION_COMPRESSION';
  return 'MIXED_ACTIVITY';
}

const COMP_BRD_MAX = 40;
const COMP_AGR_MAX = 45;

function computeExpansionPressure(sequence) {
  const trailing = [];
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (COMPRESSED_CYCLE.has(sequence[i].energy_cycle)) trailing.unshift(sequence[i]);
    else break;
  }

  const carryOver = sequence.slice(-5).map(s => ({
    session: SESS_LABEL[s.session_name] || s.session_name,
    energy:  ri(s.market_energy),
    breadth: ri(s.breadth_score),
    cycle:   s.energy_cycle,
  }));

  const flowNarrative = buildFlowNarrative(carryOver);
  const streak        = trailing.length;
  const chain         = trailing.map(s => SESS_LABEL[s.session_name] || s.session_name);

  if (streak < 2) {
    return { streak, score: 0, risk: 'NONE', chain, cycles: trailing.map(s => s.energy_cycle), carryOver, flowNarrative, factors: null };
  }

  const avgBrd = avgField(trailing, 'breadth_score');
  const avgAgr = avgField(trailing, 'agreement_score');
  if (avgBrd > COMP_BRD_MAX || avgAgr > COMP_AGR_MAX) {
    return { streak, score: 0, risk: 'NONE', chain, cycles: trailing.map(s => s.energy_cycle), carryOver, flowNarrative, factors: null };
  }

  const streakScore    = Math.min(100, streak * 34);
  const volSuppression = Math.max(0, 100 - avgField(trailing, 'volatility_score'));
  const lastSessName   = trailing[trailing.length - 1]?.session_name;
  const nextSessName   = SESS_NEXT[lastSessName] || 'LONDON';
  const transitionBonus= nextSessName === 'LONDON'   ? 80
                       : nextSessName === 'NEW_YORK'  ? 65 : 30;

  const score = Math.round(
    0.35 * streakScore    +
    0.25 * avgAgr         +
    0.25 * volSuppression +
    0.15 * transitionBonus
  );

  const risk = score >= 70 ? 'HIGH'
             : score >= 50 ? 'BUILDING'
             : score >= 25 ? 'LOW'
             :               'MINIMAL';

  return {
    streak, score, risk, chain,
    cycles:  trailing.map(s => s.energy_cycle),
    carryOver, flowNarrative,
    factors: {
      streakScore:    Math.round(streakScore),
      agrPersistence: Math.round(avgAgr),
      volSuppression: Math.round(volSuppression),
      transitionBonus,
    },
  };
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

  // Must iterate chronologically so each session can reference the previous same-session
  const sortedKeys  = Object.keys(groups).sort();
  const sessHistory = {}; // session_name → [{movement, breadth, agreement, volatility, energy}]

  return sortedKeys.map(key => {
    const g   = groups[key];
    const n   = field => g.rows.map(r => parseFloat(r[field]) || 0);
    const avg = arr   => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const firstRow = g.rows[0];
    const lastRow  = g.rows[g.rows.length - 1];

    const sessionStart = new Date(firstRow.time_utc);
    const sessionEnd   = new Date(lastRow.time_utc);
    sessionEnd.setUTCHours(sessionEnd.getUTCHours() + 1);

    const mov    = round1(avg(n('movement_score')));
    const brd    = round1(avg(n('breadth_score')));
    const agr    = round1(avg(n('agreement_score')));
    const vol    = round1(avg(n('volatility_score')));
    const eng    = round1(avg(n('market_energy')));
    const streak = lastRow.compression_streak || 0;

    // Pull same-session history so Asia compares against Asia, London vs London, NY vs NY
    const hist     = sessHistory[g.session] || [];
    const prevHist = hist[hist.length - 1];

    // Acceleration: current session energy vs previous SAME session energy.
    // Cross-session accel (hourly rows) compares Asia vs NY which is meaningless.
    const accel = prevHist ? round1(eng - prevHist.energy) : 0;

    // Classify using session-averaged scores instead of modal hourly cycle.
    // Hourly classifications are dominated by low-activity edge hours (start/end
    // of session) which vote LOW_PARTICIPATION even when peak hours show expansion.
    // Session averages reflect the true character of the full session.
    const sessionCycle = classifyEnergyCycle(
      mov, brd, agr, vol, streak, accel,
      prevHist ? { movement: prevHist.movement, breadth: prevHist.breadth } : null,
      g.session
    );

    const row = {
      session_date:        g.date,
      session_name:        g.session,
      session_zone:        null,
      session_start:       sessionStart.toISOString(),
      session_end:         sessionEnd.toISOString(),
      movement_score:      mov,
      breadth_score:       brd,
      agreement_score:     agr,
      volatility_score:    vol,
      acceleration_score:  accel,
      compression_score:   round1(avg(n('compression_score'))),
      compression_streak:  streak,
      expansion_readiness: round1(avg(n('expansion_readiness'))),
      market_energy:       eng,
      energy_cycle:        sessionCycle,
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

    // ── In-memory session-relative normalization ──────────────────────────────
    if (hist.length >= 1) {
      const hMov = avg(hist.map(h => h.movement));
      const hBrd = avg(hist.map(h => h.breadth));
      const hAgr = avg(hist.map(h => h.agreement));
      const hVol = avg(hist.map(h => h.volatility));
      const hEng = avg(hist.map(h => h.energy));
      row.norm_movement   = pctVsRef(mov, hMov);
      row.norm_breadth    = pctVsRef(brd, hBrd);
      row.norm_agreement  = pctVsRef(agr, hAgr);
      row.norm_volatility = pctVsRef(vol, hVol);
      row.norm_energy     = pctVsRef(eng, hEng);
      row.baseline_n      = hist.length;
    }
    if (prevHist) {
      row.prev_movement  = pctVsRef(mov, prevHist.movement);
      row.prev_breadth   = pctVsRef(brd, prevHist.breadth);
      row.prev_agreement = pctVsRef(agr, prevHist.agreement);
      row.prev_energy    = pctVsRef(eng, prevHist.energy);
      // Use absolute delta for momentum — avoids pctVsRef returning null when
      // a prior session had near-zero energy (e.g. 5 → 26 = 420%, gets capped).
      const energyDelta = eng - prevHist.energy;
      row.energy_momentum = energyDelta > 5  ? 'ACCELERATING'
                          : energyDelta < -5 ? 'DECELERATING'
                          :                    'STABLE';
    }

    if (!sessHistory[g.session]) sessHistory[g.session] = [];
    sessHistory[g.session].push({ movement: mov, breadth: brd, agreement: agr, volatility: vol, energy: eng });

    return row;
  });
}

// Fields computed in-memory for the API — not stored in market_energy_sessions
const SESSION_INMEM_FIELDS = new Set([
  'norm_movement', 'norm_breadth', 'norm_agreement', 'norm_volatility', 'norm_energy',
  'baseline_n',
  'prev_movement', 'prev_breadth', 'prev_agreement', 'prev_energy',
  'energy_momentum',
]);

function toSessionRow(r) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !SESSION_INMEM_FIELDS.has(k)));
}

async function upsertMarketEnergySessions(sessionRows) {
  if (!sessionRows.length) return;
  const { error } = await supabase
    .from('market_energy_sessions')
    .upsert(sessionRows.map(toSessionRow), { onConflict: 'session_date,session_name', ignoreDuplicates: false });
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

// ─── Market energy report (in-memory — called by api/market-energy.js) ────────

async function getMarketEnergyData() {
  const byTime   = await fetchHourlyCandles(200);
  const hourKeys = Object.keys(byTime).sort();
  if (!hourKeys.length) return null;

  const hourRows    = processHours(hourKeys, byTime);
  const sessionRows = buildSessionRows(hourRows);

  // Most recent occurrence per session for the dashboard cards
  const bySession = {};
  for (const row of sessionRows) bySession[row.session_name] = row;
  const sessions = SESSION_ORDER.map(n => bySession[n]).filter(Boolean);

  // Chronological sequence (exclude LOW_LIQUIDITY) for cross-session analysis
  const sequence = sessionRows
    .filter(r => r.session_name !== 'LOW_LIQUIDITY')
    .slice(-8);

  const expansionPressure = computeExpansionPressure(sequence);
  const marketCycle       = classifyMarketCycle(sequence);

  const { getCurrentSession } = require('./sessionEngine');
  const currentSession = getCurrentSession().session;

  return { sessions, expansionPressure, marketCycle, currentSession };
}

module.exports = { backfillSessionActivity, calculateLatestSessionActivity, computeSessionSummaries, getMarketEnergyData };
