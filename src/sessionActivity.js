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

// ─── Calibrated scaling thresholds (from 30-day raw candle analysis) ─────────
// These define what "100" means for each metric in each session.
// Derived from P90 values × 1.2 so P90 ≈ 83, extreme days reach 100.
//
// hourlyMove: single-candle |close - open| / open (per-pair average)
// hourlyRange: single-candle (high - low) / open (per-pair average)
// breadthThreshold: hourly move threshold to count a pair as "active"
//                   (calibrated to P25 of hourly single-candle moves)

const SESSION_SCALE = {
  ASIA: {
    movementCap: 0.0012,   // 0.12% avg hourly move = score 100
    volatilityCap: 0.0020, // 0.20% avg hourly range = score 100
    breadthThreshold: 0.00015, // 0.015% = pair is "active" this hour
  },
  LONDON: {
    movementCap: 0.0015,   // 0.15% avg hourly move = score 100
    volatilityCap: 0.0025, // 0.25% avg hourly range = score 100
    breadthThreshold: 0.00020, // 0.020%
  },
  NEW_YORK: {
    movementCap: 0.0018,   // 0.18% avg hourly move = score 100
    volatilityCap: 0.0030, // 0.30% avg hourly range = score 100
    breadthThreshold: 0.00020, // 0.020%
  },
  DEFAULT: {
    movementCap: 0.0015,
    volatilityCap: 0.0025,
    breadthThreshold: 0.00020,
  },
};

// ─── Candle fetch ─────────────────────────────────────────────────────────────

async function fetchHourlyCandles(limit = 300) {
  const byTime = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, open, high, low, close')
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
        open:  parseFloat(c.open),
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

// Thresholds calibrated for raw-based scoring (no EMA/normalization).
// Movement and volatility now use session-calibrated pip scales (0-100).
// Breadth counts pairs with meaningful HOURLY moves (not cumulative).
// Agreement measures hourly-vs-session trend continuation.
const SESS_PROFILE = {
  ASIA: {
    // Asia: quieter session. P50 mov≈35, P50 brd≈55, typical agr≈40-60
    deadMov:  8, deadBrd: 15, deadVol: 10,
    exMov:   65, exBrd:   80, exAgr:   70,   // EXPLOSIVE
    expMov:  30, expBrd:  45, expAgr:  35,   // EXPANSION
    exhMov:  30,
    trBrd:   30, trAgr:   25, trMov:   20,   // TRANSITION
    cmpBrd:  25,                              // COMPRESSION
  },
  LONDON: {
    // London: active session. P50 mov≈45, P50 brd≈65, typical agr≈50-70
    deadMov: 10, deadBrd: 20, deadVol: 12,
    exMov:   75, exBrd:   85, exAgr:   75,
    expMov:  40, expBrd:  55, expAgr:  45,
    exhMov:  40,
    trBrd:   35, trAgr:   30, trMov:   25,
    cmpBrd:  30,
  },
  NEW_YORK: {
    // NY: most active. P50 mov≈40, P50 brd≈60, typical agr≈45-65
    deadMov: 10, deadBrd: 20, deadVol: 12,
    exMov:   70, exBrd:   85, exAgr:   70,
    expMov:  35, expBrd:  50, expAgr:  40,
    exhMov:  35,
    trBrd:   35, trAgr:   30, trMov:   25,
    cmpBrd:  30,
  },
  DEFAULT: {
    deadMov: 12, deadBrd: 20, deadVol: 15,
    exMov:   70, exBrd:   80, exAgr:   70,
    expMov:  35, expBrd:  50, expAgr:  40,
    exhMov:  35,
    trBrd:   30, trAgr:   30, trMov:   25,
    cmpBrd:  25,
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

  // Current session tracking
  let currentSession    = null;
  let sessionOpenPrices = {};
  let sessionHigh       = {};
  let sessionLow        = {};

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

  // Previous candles for hourly-vs-session agreement
  let prevCandles = null;

  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = classifyHour(hk);

    // ── Session transition ──────────────────────────────────────────────────
    if (session !== currentSession) {
      if (currentSession && currentSession !== 'LOW_LIQUIDITY') {
        // Capture session averages before resetting
        const avgMov = arrAvg(sessionMovList);
        const avgBrd = arrAvg(sessionBrdList);
        const avgAgr = arrAvg(sessionAgrList);
        const avgVol = arrAvg(sessionVolList);

        // Update compression streak
        if (avgMov < 35 && avgBrd < 35 && avgVol < 40) compressionStreak++;
        else compressionStreak = 0;

        // Carry energy base forward (same-session only)
        if (sessionEBList.length) prevSameSessionEnergy[currentSession] = arrAvg(sessionEBList);

        // Store per-session scores so Asia compares against previous Asia (not NY)
        prevSameSessionScores[currentSession] = { movement: avgMov, breadth: avgBrd, agreement: avgAgr, volatility: avgVol };
      }

      // Reset for new session
      sessionOpenPrices = {};
      sessionHigh       = {};
      sessionLow        = {};
      sessionEBList     = [];
      sessionMovList    = [];
      sessionBrdList    = [];
      sessionAgrList    = [];
      sessionVolList    = [];

      for (const [inst, c] of Object.entries(candles)) {
        sessionOpenPrices[inst] = c.open;  // candle OPEN = true session start price
        sessionHigh[inst]       = c.high;
        sessionLow[inst]        = c.low;
      }
      currentSession = session;
    }

    if (session === 'LOW_LIQUIDITY') { prevCandles = candles; continue; }

    // ── Update running session high/low ────────────────────────────────────
    for (const [inst, c] of Object.entries(candles)) {
      if (c.high != null && (sessionHigh[inst] == null || c.high > sessionHigh[inst])) sessionHigh[inst] = c.high;
      if (c.low  != null && (sessionLow[inst]  == null || c.low  < sessionLow[inst]))  sessionLow[inst]  = c.low;
    }

    const scale = SESSION_SCALE[session] || SESSION_SCALE.DEFAULT;

    // ── Currency strength (cumulative session moves) ────────────────────────
    const ccyStrength = computeCurrencyStrengths(candles, sessionOpenPrices);
    let strongestCcy = null, weakestCcy = null;
    {
      const sorted = Object.entries(ccyStrength).sort((a, b) => b[1] - a[1]);
      if (sorted.length >= 2) {
        strongestCcy = sorted.slice(0, 2).map(e => e[0]).join(',');
        weakestCcy   = sorted.slice(-2).reverse().map(e => e[0]).join(',');
      }
    }

    // ── Per-pair hourly calculations ────────────────────────────────────────
    // Movement & breadth use HOURLY candle moves (open→close of THIS candle)
    // Agreement uses hourly direction vs cumulative session direction
    // Volatility uses hourly candle range (high-low)
    const hourlyMoves  = [];
    const hourlyRanges = [];
    let activePairs    = 0;
    let bullishMag = 0, bearishMag = 0;

    // Agreement: does this hour continue the session trend per currency?
    // Currency strength = session-to-date trend. Hourly direction = this candle.
    // If session shows GBP strong and this hour GBP pairs ALSO rise → aligned.
    // This breaks the tautology because session strength uses session open→current close,
    // while hourly direction uses candle open→candle close (different time window).
    let agrAligned = 0, agrTotal = 0;

    for (const inst of config.instruments) {
      const c    = candles[inst];
      const sOpen = sessionOpenPrices[inst];
      if (!c || !c.open || c.open === 0 || sOpen == null) continue;

      // Hourly candle move (THIS hour's activity)
      const hourlyDir  = (c.close - c.open) / c.open;
      const hourlyMove = Math.abs(hourlyDir);
      hourlyMoves.push(hourlyMove);

      // Hourly candle range
      const hourlyRange = (c.high - c.low) / c.open;
      hourlyRanges.push(hourlyRange);

      // Is this pair "active" this hour?
      if (hourlyMove >= scale.breadthThreshold) {
        activePairs++;
        if (hourlyDir > 0) bullishMag += hourlyMove;
        else               bearishMag += hourlyMove;
      }

      // Agreement: does this hour's direction match session-to-date direction?
      const sessionDir = (c.close - sOpen) / sOpen; // cumulative session move
      if (Math.abs(hourlyDir) >= scale.breadthThreshold * 0.5 &&
          Math.abs(sessionDir) >= scale.breadthThreshold * 0.5) {
        agrTotal++;
        if ((hourlyDir > 0 && sessionDir > 0) || (hourlyDir < 0 && sessionDir < 0)) {
          agrAligned++;
        }
      }
    }

    if (!hourlyMoves.length) { prevCandles = candles; continue; }

    // ── Movement score (0-100) ──────────────────────────────────────────────
    // Based on actual hourly pip movement, scaled by session-calibrated cap
    const avgHourlyMove = arrAvg(hourlyMoves);
    const movementScore = round1(Math.min(100, (avgHourlyMove / scale.movementCap) * 100));

    // ── Breadth score (0-100) ───────────────────────────────────────────────
    // Percentage of pairs with meaningful activity THIS hour
    const breadthScore = round1((activePairs / TOTAL) * 100);

    // ── Agreement score (0-100) ─────────────────────────────────────────────
    // Measures trend continuation: are this hour's moves consistent with session direction?
    // High = market trending consistently. Low = choppy/reversing.
    // Weighted by √(breadth) so low participation doesn't produce misleading agreement.
    const rawAgrRatio    = agrTotal > 0 ? agrAligned / agrTotal : 0;
    const agreementScore = round1(rawAgrRatio * Math.sqrt(breadthScore / 100) * 100);

    // ── Volatility score (0-100) ────────────────────────────────────────────
    // Based on actual hourly candle range (high-low)
    const avgHourlyRange = arrAvg(hourlyRanges);
    const volatilityScore = round1(Math.min(100, (avgHourlyRange / scale.volatilityCap) * 100));

    // ── Directional pressure ────────────────────────────────────────────────
    const totalMag = bullishMag + bearishMag;
    const bullishPressurePct = totalMag > 0 ? round1(bullishMag / totalMag * 100) : 50;
    const bearishPressurePct = totalMag > 0 ? round1(bearishMag / totalMag * 100) : 50;
    const dominanceScore = totalMag > 0
      ? round1(Math.abs(bullishMag - bearishMag) / totalMag * 100) : 0;

    // ── Energy base and acceleration ────────────────────────────────────────
    const energyBase   = round1(0.45 * movementScore + 0.35 * breadthScore + 0.20 * volatilityScore);
    const prevSessEB   = prevSameSessionEnergy[session] ?? null;
    const acceleration = prevSessEB != null ? round1(energyBase - prevSessEB) : 0;

    // ── Market energy (composite) ───────────────────────────────────────────
    // Agreement acts as quality multiplier — organized moves produce more energy
    const rawEnergy    = 0.40 * movementScore + 0.30 * breadthScore + 0.20 * agreementScore + 0.10 * volatilityScore;
    const qualityMult  = 0.5 + agreementScore / 200; // 0.5 (agr=0) → 1.0 (agr=100)
    const marketEnergy = round1(Math.min(100, rawEnergy * qualityMult));

    // ── Compression score ───────────────────────────────────────────────────
    const compressionScore = round1(((100 - movementScore) * (100 - breadthScore)) / 100);

    // ── Expansion readiness ─────────────────────────────────────────────────
    const streakScore    = Math.min(100, compressionStreak * 25);
    const energyPressure = Math.max(0, 100 - marketEnergy);
    const sessQualScore  = SESSION_QUALITY_SCORE[session] || 50;
    const accelScore     = Math.min(100, Math.max(0, 50 + acceleration * 2));
    const expansionReadiness = round1(Math.min(100,
      0.35 * streakScore
      + 0.25 * energyPressure
      + 0.20 * accelScore
      + 0.10 * sessQualScore
      + 0.10 * agreementScore
    ));

    // ── Energy cycle classification ─────────────────────────────────────────
    const energyCycle = classifyEnergyCycle(
      movementScore, breadthScore, agreementScore, volatilityScore,
      compressionStreak, acceleration, prevSameSessionScores[session] || null, session
    );

    // Accumulate session lists
    sessionEBList.push(energyBase);
    sessionMovList.push(movementScore);
    sessionBrdList.push(breadthScore);
    sessionAgrList.push(agreementScore);
    sessionVolList.push(volatilityScore);

    rows.push({
      time_utc:             hk,
      session_name:         session,
      movement_score:       movementScore,
      breadth_score:        breadthScore,
      agreement_score:      agreementScore,
      volatility_score:     volatilityScore,
      energy_base:          energyBase,
      acceleration:         acceleration,
      compression_score:    compressionScore,
      expansion_score:      round1((movementScore * breadthScore) / 100),
      market_energy:        marketEnergy,
      expansion_readiness:  expansionReadiness,
      energy_cycle:         energyCycle,
      compression_streak:   compressionStreak,
      pairs_moving:         activePairs,
      pairs_quiet:          TOTAL - activePairs,
      movement_magnitude:   round1(avgHourlyMove * 10000), // in pips (×10000)
      bullish_breadth:      bullishPressurePct,
      bearish_breadth:      bearishPressurePct,
      dominance_score:      dominanceScore,
      strongest_ccy:        strongestCcy,
      weakest_ccy:          weakestCcy,
      directional_agreement: agreementScore,
    });

    prevCandles = candles;
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
  let prevFlowBullPct = 50; // tracks preceding session's bullPct (intraday flow: Asia→London→NY)

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

    // ── Liquidity score ──────────────────────────────────────────────────────
    // Identifies sessions with genuine directional liquidity (real moves) vs noise.
    // Components:
    //   breadthCoherence:  Brd/Mov ratio — pairs moving together vs scattered
    //   eMagnitude:        market energy — the composite strength of the session
    //   directionalBias:   how skewed bull/bear pressure is (50/50 = no conviction)
    //   flowPersistence:   same bias as preceding session today = institutional carry
    const bullPct  = round1(avg(n('bullish_breadth')));
    const bearPct  = round1(avg(n('bearish_breadth')));

    const breadthCoherence = mov > 0 ? Math.min(1, brd / mov) : 0;
    const eMagnitude       = Math.min(100, eng);
    const directionalBias  = Math.abs(bullPct - 50) / 50; // 0 = split, 1 = one-sided
    const currDominant     = bullPct >= bearPct ? 'bull' : 'bear';
    const prevFlowDominant = prevFlowBullPct >= 50 ? 'bull' : 'bear';
    const flowPersistence  = currDominant === prevFlowDominant ? 1.0 : 0.6;

    // Weighted composite: energy is the base, coherence and bias amplify it
    const liquidityScore = round1(Math.min(100,
      eMagnitude * (0.35 + 0.30 * breadthCoherence + 0.20 * directionalBias + 0.15 * flowPersistence)
    ));

    const liquidityGrade = liquidityScore >= 40 ? 'HIGH'
                         : liquidityScore >= 25 ? 'MODERATE'
                         : liquidityScore >= 12 ? 'LOW'
                         :                        'DEAD';

    prevFlowBullPct = bullPct;

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
      liquidity_score:     liquidityScore,
      liquidity_grade:     liquidityGrade,
      active_pairs:        Math.round(avg(n('pairs_moving'))),
      aligned_pairs:       null,
      bullish_breadth:     bullPct,
      bearish_breadth:     bearPct,
      dominance_score:     round1(avg(n('dominance_score'))),
      strongest_ccy:       lastRow.strongest_ccy || null,
      weakest_ccy:         lastRow.weakest_ccy   || null,
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
    sessHistory[g.session].push({ movement: mov, breadth: brd, agreement: agr, volatility: vol, energy: eng, bullPct });

    return row;
  });
}

// Fields computed in-memory — stored inside the `details` JSON column
const SESSION_INMEM_FIELDS = new Set([
  'norm_movement', 'norm_breadth', 'norm_agreement', 'norm_volatility', 'norm_energy',
  'baseline_n',
  'prev_movement', 'prev_breadth', 'prev_agreement', 'prev_energy',
  'energy_momentum',
]);

function toSessionRow(r) {
  const computed = {};
  const row = {};
  for (const [k, v] of Object.entries(r)) {
    if (SESSION_INMEM_FIELDS.has(k)) computed[k] = v;
    else row[k] = v;
  }
  if (!row.details) row.details = {};
  row.details = { ...row.details, ...computed };
  return row;
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

async function backfillSessionActivity({ fullRewrite = false } = {}) {
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

  const allSessionRows = buildSessionRows(rows);

  if (fullRewrite) {
    // Manual admin backfill — overwrite everything
    await upsertMarketEnergySessions(allSessionRows);
  } else {
    // Hourly pipeline — only upsert today's active session + any new sessions
    // not yet in DB. Completed sessions keep their original scores to prevent
    // rolling averages/EMA from inflating values retroactively.
    const { getCurrentSession } = require('./sessionEngine');
    const activeSession = getCurrentSession().session;
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRows = allSessionRows.filter(sr => sr.session_date === todayStr);

    if (todayRows.length) {
      const { data: existing } = await supabase
        .from('market_energy_sessions')
        .select('session_name')
        .eq('session_date', todayStr);
      const existingNames = new Set((existing || []).map(r => r.session_name));

      // Upsert: active session (always) + any new sessions not yet stored
      const toUpsert = todayRows.filter(
        sr => sr.session_name === activeSession || !existingNames.has(sr.session_name)
      );
      if (toUpsert.length) {
        await upsertMarketEnergySessions(toUpsert);
      }
    }
  }

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

  // Only upsert the CURRENT active session — completed sessions keep their
  // stored scores. Recomputing all 4 shifts rolling averages/EMA context and
  // inflates completed session values retroactively.
  const { getCurrentSession } = require('./sessionEngine');
  const activeSession = getCurrentSession().session;
  const todayStr = new Date().toISOString().slice(0, 10);
  const sessionRows = buildSessionRows(allRows);
  const currentOnly = sessionRows.filter(
    sr => sr.session_name === activeSession && sr.session_date === todayStr
  );
  if (currentOnly.length) {
    await upsertMarketEnergySessions(currentOnly);
  }

  console.log(
    `[SESSION_ACTIVITY] ✓ ${row.time_utc} | ${row.session_name} | ${row.energy_cycle}` +
    ` | energy:${row.market_energy} ready:${row.expansion_readiness}` +
    ` | mov:${row.movement_score} brd:${row.breadth_score} agr:${row.agreement_score} vol:${row.volatility_score}` +
    ` | acc:${row.acceleration >= 0 ? '+' : ''}${row.acceleration} streak:${row.compression_streak}`
  );

  await computeSessionSummaries();
  return row;
}

// ─── Market energy report (pure DB — called by api/market-energy.js) ──────────
// All data comes from stored DB tables. No in-memory candle computation.
// The pipeline (run-pipeline cron) keeps market_energy_sessions up to date.

async function getMarketEnergyData() {
  const { getCurrentSession } = require('./sessionEngine');
  const currentSession = getCurrentSession().session;
  const todayStr = new Date().toISOString().slice(0, 10);

  // Read today's sessions from DB
  const { data: dbSessions, error: dbErr } = await supabase
    .from('market_energy_sessions')
    .select('*')
    .eq('session_date', todayStr)
    .order('session_name', { ascending: true });

  if (dbErr) console.warn('[ME] DB read error:', dbErr.message);
  if (!dbSessions?.length) return null;

  const storedByName = {};
  for (const row of dbSessions) {
    // Merge computed fields from details JSON back to top-level
    if (row.details && typeof row.details === 'object') {
      const { hours, hourly, ...computed } = row.details;
      Object.assign(row, computed);
      row.details = { hours, hourly };
    }
    storedByName[row.session_name] = row;
  }

  const sessions = SESSION_ORDER.map(n => storedByName[n]).filter(Boolean);

  // Cross-session analysis: read recent sessions for expansion pressure + market cycle
  const { data: recentSessions } = await supabase
    .from('market_energy_sessions')
    .select('*')
    .neq('session_name', 'LOW_LIQUIDITY')
    .order('session_date', { ascending: false })
    .order('session_name', { ascending: false })
    .limit(8);

  const sequence = (recentSessions || []).reverse().map(row => {
    if (row.details && typeof row.details === 'object') {
      const { hours, hourly, ...computed } = row.details;
      Object.assign(row, computed);
      row.details = { hours, hourly };
    }
    return row;
  });

  const expansionPressure = computeExpansionPressure(sequence);
  const marketCycle       = classifyMarketCycle(sequence);

  return { sessions, expansionPressure, marketCycle, currentSession };
}

module.exports = { backfillSessionActivity, calculateLatestSessionActivity, computeSessionSummaries, getMarketEnergyData };
