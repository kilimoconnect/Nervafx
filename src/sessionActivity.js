'use strict';

/**
 * Session Activity Engine — V2 Institutional Calculation Model
 *
 * Engines (per NervaFX_Market_Energy_Calculation_Model.pdf):
 *  1. Movement Engine        — pair moves normalized by session-calibrated caps
 *  2. Momentum Engine        — hour-over-hour movement delta + classification
 *  3. Agreement Engine       — currency alignment × pair alignment
 *  4. Volatility Quality     — classify healthy/chaotic/dead/event + quality score
 *  5. Directional Pressure   — bull/bear pressure + directional control
 *  6. Participation Engine   — breadth (active pairs %)
 *  7. Currency Leadership    — strongest vs weakest currency gap
 *  8. Market Energy          — weighted composite × session quality
 *  9. Tradability Engine     — geometric-mean gated composite
 * 10. False Breakout Detect  — movement up + weak breadth + weak agreement
 * 11. Expansion Readiness    — compression persistence + volatility contraction
 * 12. Market Cycle Engine    — regime classification with confidence
 *
 * DB tables:
 *   hourly_session_activity  — per-hour metrics
 *   market_energy_sessions   — per-session aggregated metrics
 *   session_performance_summary — legacy summaries
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

// Geometric mean of positive values (returns 0 if any is 0)
function geoMean(vals) {
  if (!vals.length) return 0;
  if (vals.some(v => v <= 0)) return 0;
  const logSum = vals.reduce((s, v) => s + Math.log(v), 0);
  return Math.exp(logSum / vals.length);
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

const SESSION_SCALE = {
  ASIA: {
    movementCap: 0.0012,       // 0.12% avg hourly move = score 100
    volatilityCap: 0.0020,     // 0.20% avg hourly range = score 100
    breadthThreshold: 0.00015, // 0.015% = pair is "active" this hour
  },
  LONDON: {
    movementCap: 0.0015,
    volatilityCap: 0.0025,
    breadthThreshold: 0.00020,
  },
  NEW_YORK: {
    movementCap: 0.0018,
    volatilityCap: 0.0030,
    breadthThreshold: 0.00020,
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

// ─── 12H Currency Strength index for dispersion engine ───────────────────────

async function _fetchCsStrengthIndex(earliest) {
  try {
    const index = {};
    const PAGE = 5000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('currency_strength')
        .select('time, currency, smooth_12h')
        .gte('time', earliest)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error || !data?.length) break;
      for (const r of data) {
        const hk = new Date(r.time).toISOString();
        if (!index[hk]) index[hk] = {};
        index[hk][r.currency] = parseFloat(r.smooth_12h) || 0;
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    return index;
  } catch (_) {
    return {};
  }
}

// ─── Session classification ───────────────────────────────────────────────────

function classifyHour(isoTime) {
  return getCurrentSession(new Date(isoTime)).session;
}

// ─── Currency strength ──────────────────────────────────────────────────────

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

// ─── Momentum classification ────────────────────────────────────────────────
// Types: TREND (steady positive), EXPANSION (accelerating), IMPULSE (sudden spike),
//        EXHAUSTION (high but decelerating), DECAY (falling), STABLE (flat)

function classifyMomentum(momentumScore, momentumAccel, movementScore, prevMovement) {
  const absMom = Math.abs(momentumScore);

  // IMPULSE: sudden large spike in movement this hour
  if (momentumScore > 15 && movementScore >= 50) return 'IMPULSE';

  // EXPANSION: movement accelerating (positive momentum + positive acceleration)
  if (momentumScore > 5 && momentumAccel > 2) return 'EXPANSION';

  // EXHAUSTION: movement still high but decelerating
  if (movementScore >= 40 && momentumScore < -5) return 'EXHAUSTION';

  // TREND: steady positive momentum
  if (momentumScore > 3) return 'TREND';

  // DECAY: movement contracting
  if (momentumScore < -3) return 'DECAY';

  return 'STABLE';
}

// ─── Volatility quality classification ──────────────────────────────────────
// HEALTHY: high vol + high agreement + good directional control → tradable
// CHAOTIC: high vol + low agreement + low directional control → dangerous
// EVENT:   extreme vol spike vs previous hour → news/event driven
// NORMAL:  moderate vol
// DEAD:    very low vol

function classifyVolatility(volScore, agrScore, dirControl, prevVolScore) {
  // EVENT: extreme spike (>1.8x previous hour's vol AND vol >= 50)
  if (prevVolScore != null && volScore > prevVolScore * 1.8 && volScore >= 50) return 'EVENT';

  if (volScore >= 55) {
    if (agrScore >= 45 && dirControl >= 35) return 'HEALTHY';
    if (agrScore < 30 || dirControl < 20) return 'CHAOTIC';
    return 'HEALTHY'; // borderline → lean healthy
  }
  if (volScore >= 25) return 'NORMAL';
  return 'DEAD';
}

// Volatility quality score: rewards healthy vol, penalizes chaotic
function computeVolatilityQuality(volScore, volType) {
  const multiplier = {
    HEALTHY: 1.0,
    NORMAL:  0.75,
    EVENT:   0.50,
    CHAOTIC: 0.30,
    DEAD:    0.20,
  };
  return round1(volScore * (multiplier[volType] || 0.5));
}

// ─── Energy cycle classification ────────────────────────────────────────────

const SESS_PROFILE = {
  ASIA: {
    deadMov:  8, deadBrd: 15, deadVol: 10,
    exMov:   65, exBrd:   80, exAgr:   70,
    expMov:  30, expBrd:  45, expAgr:  35,
    exhMov:  30,
    trBrd:   30, trAgr:   25, trMov:   20,
    cmpBrd:  25,
  },
  LONDON: {
    deadMov: 10, deadBrd: 20, deadVol: 12,
    exMov:   75, exBrd:   85, exAgr:   75,
    expMov:  40, expBrd:  55, expAgr:  45,
    exhMov:  40,
    trBrd:   35, trAgr:   30, trMov:   25,
    cmpBrd:  30,
  },
  NEW_YORK: {
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

function processHours(hourKeys, byTime, onlyLast = false, _csStrengthIndex = null) {
  const TOTAL = config.instruments.length; // 28

  // Current session tracking
  let currentSession    = null;
  let sessionOpenPrices = {};
  let sessionHigh       = {};
  let sessionLow        = {};

  // Per-session-type carry-over
  const prevSameSessionEnergy = {};
  const prevSameSessionScores = {};
  let compressionStreak = 0;

  // Running session accumulators
  let sessionEBList  = [];
  let sessionMovList = [];
  let sessionBrdList = [];
  let sessionAgrList = [];
  let sessionVolList = [];

  // Previous hour tracking (for momentum engine)
  let prevHourScores = null;
  let prevCandles    = null;

  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = classifyHour(hk);

    // ── Session transition ──────────────────────────────────────────────────
    if (session !== currentSession) {
      if (currentSession && currentSession !== 'LOW_LIQUIDITY') {
        const avgMov = arrAvg(sessionMovList);
        const avgBrd = arrAvg(sessionBrdList);
        const avgAgr = arrAvg(sessionAgrList);
        const avgVol = arrAvg(sessionVolList);

        if (avgMov < 35 && avgBrd < 35 && avgVol < 40) compressionStreak++;
        else compressionStreak = 0;

        if (sessionEBList.length) prevSameSessionEnergy[currentSession] = arrAvg(sessionEBList);
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
      prevHourScores    = null; // reset momentum at session boundary

      for (const [inst, c] of Object.entries(candles)) {
        sessionOpenPrices[inst] = c.open;
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

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 7: Currency Leadership
    // ═══════════════════════════════════════════════════════════════════════
    const strengthVals = Object.values(ccyStrength).sort((a, b) => b - a);
    const currencyLeadershipGap = strengthVals.length >= 2
      ? round1((strengthVals[0] - strengthVals[strengthVals.length - 1]) * 10000) / 10000
      : 0;

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 14: Currency Dispersion (strongest − weakest 12H strength, 0-100)
    // Uses pre-fetched smooth_12h from currency_strength table — the real
    // multi-session capital flow that drives tradable trends.
    // Falls back to session-level ccyStrength gap if 12H data unavailable.
    // ═══════════════════════════════════════════════════════════════════════
    const DISPERSION_CAP = 0.006; // 12H gap of 60 pips (0.006) = score 100
    let dispersionGap = currencyLeadershipGap; // fallback
    const csHourData = _csStrengthIndex?.[hk];
    if (csHourData && Object.keys(csHourData).length >= 4) {
      const vals12H = Object.values(csHourData).sort((a, b) => b - a);
      dispersionGap = vals12H[0] - vals12H[vals12H.length - 1];
    }
    const dispersionScore = round1(Math.min(100, (dispersionGap / DISPERSION_CAP) * 100));

    // ── Per-pair hourly calculations ────────────────────────────────────────
    const hourlyMoves  = [];
    const hourlyRanges = [];
    const hourlyDEs    = []; // Directional Efficiency per pair
    let activePairs    = 0;
    let bullishMag = 0, bearishMag = 0;
    let agrAligned = 0, agrTotal = 0;

    // Currency alignment: does each pair move consistently with currency strength?
    let ccyAligned = 0, ccyTotal = 0;

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

      // Directional Efficiency: body / range × 100 (how directional is the candle)
      const range = c.high - c.low;
      if (range > 0) {
        hourlyDEs.push(Math.abs(c.close - c.open) / range * 100);
      }

      // Breadth: is this pair "active" this hour?
      if (hourlyMove >= scale.breadthThreshold) {
        activePairs++;
        if (hourlyDir > 0) bullishMag += hourlyMove;
        else               bearishMag += hourlyMove;
      }

      // ═══════════════════════════════════════════════════════════════════
      // ENGINE 3: Agreement — pair alignment (hourly vs session direction)
      // ═══════════════════════════════════════════════════════════════════
      const sessionDir = (c.close - sOpen) / sOpen;
      if (Math.abs(hourlyDir) >= scale.breadthThreshold * 0.5 &&
          Math.abs(sessionDir) >= scale.breadthThreshold * 0.5) {
        agrTotal++;
        if ((hourlyDir > 0 && sessionDir > 0) || (hourlyDir < 0 && sessionDir < 0)) {
          agrAligned++;
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // ENGINE 3: Agreement — currency alignment
      // Does pair direction match currency strength expectation?
      // ═══════════════════════════════════════════════════════════════════
      const [base, quote] = inst.split('_');
      const expectedDir = (ccyStrength[base] || 0) - (ccyStrength[quote] || 0);
      if (Math.abs(hourlyDir) >= scale.breadthThreshold * 0.5 && Math.abs(expectedDir) > 0.00001) {
        ccyTotal++;
        if ((expectedDir > 0 && hourlyDir > 0) || (expectedDir < 0 && hourlyDir < 0)) {
          ccyAligned++;
        }
      }
    }

    if (!hourlyMoves.length) { prevCandles = candles; continue; }

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 13: Directional Efficiency (avg body/range across all pairs)
    // ═══════════════════════════════════════════════════════════════════════
    const deScore = hourlyDEs.length > 0
      ? round1(hourlyDEs.reduce((s, v) => s + v, 0) / hourlyDEs.length)
      : 0;

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 1: Movement
    // ═══════════════════════════════════════════════════════════════════════
    const avgHourlyMove = arrAvg(hourlyMoves);
    const movementScore = round1(Math.min(100, (avgHourlyMove / scale.movementCap) * 100));

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 6: Participation (Breadth)
    // ═══════════════════════════════════════════════════════════════════════
    const breadthScore = round1((activePairs / TOTAL) * 100);

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 3: Agreement (combined: currency × pair alignment)
    // ═══════════════════════════════════════════════════════════════════════
    const pairAlignment = agrTotal > 0 ? agrAligned / agrTotal : 0;
    const ccyAlignment  = ccyTotal > 0 ? ccyAligned / ccyTotal : 0;
    // Combined agreement: product of alignments, weighted by breadth participation
    const rawAgreement   = pairAlignment * ccyAlignment;
    const agreementScore = round1(rawAgreement * Math.sqrt(breadthScore / 100) * 100);

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 5: Directional Pressure
    // ═══════════════════════════════════════════════════════════════════════
    const totalMag = bullishMag + bearishMag;
    const bullishPressurePct = totalMag > 0 ? round1(bullishMag / totalMag * 100) : 50;
    const bearishPressurePct = totalMag > 0 ? round1(bearishMag / totalMag * 100) : 50;
    // directional_control: how one-sided is the pressure? 0 = split, 100 = one-sided
    const directionalControl = totalMag > 0
      ? round1(Math.abs(bullishMag - bearishMag) / totalMag * 100) : 0;

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 4: Volatility Quality
    // ═══════════════════════════════════════════════════════════════════════
    const avgHourlyRange  = arrAvg(hourlyRanges);
    const volatilityScore = round1(Math.min(100, (avgHourlyRange / scale.volatilityCap) * 100));
    const volatilityType  = classifyVolatility(
      volatilityScore, agreementScore, directionalControl,
      prevHourScores ? prevHourScores.volatility : null
    );
    const volatilityQuality = computeVolatilityQuality(volatilityScore, volatilityType);
    // chaos_score: high volatility + low agreement + low directional control = chaos
    const chaosScore = round1(
      (volatilityScore / 100) * (1 - agreementScore / 100) * (1 - directionalControl / 100) * 100
    );

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 2: Momentum (hour-over-hour movement delta)
    // ═══════════════════════════════════════════════════════════════════════
    const momentumScore = prevHourScores
      ? round1(movementScore - prevHourScores.movement)
      : 0;
    const momentumAccel = prevHourScores?.momentum != null
      ? round1(momentumScore - prevHourScores.momentum)
      : 0;
    const momentumType = classifyMomentum(
      momentumScore, momentumAccel, movementScore,
      prevHourScores ? prevHourScores.movement : null
    );

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 8: Market Energy (participation-driven formula)
    // energy = 0.45×breadth + 0.35×movement + 0.10×volatility
    //        + 0.10×volatility_quality
    // ═══════════════════════════════════════════════════════════════════════
    const energyBase = round1(
      0.45 * breadthScore +
      0.35 * movementScore +
      0.10 * volatilityScore +
      0.10 * volatilityQuality
    );
    const marketEnergy = round1(Math.min(100, energyBase));

    // Acceleration (vs previous same-session energy)
    const prevSessEB   = prevSameSessionEnergy[session] ?? null;
    const acceleration = prevSessEB != null ? round1(energyBase - prevSessEB) : 0;

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 9: Tradability (weighted formula)
    // tradability = 0.40×DE + 0.30×momentum + 0.20×agreement + 0.10×breadth
    // Momentum is a delta (can be negative) — clamped at 0 so decaying
    // momentum doesn't contribute.
    // ═══════════════════════════════════════════════════════════════════════
    const tradabilityScore = round1(Math.min(100,
      0.40 * deScore +
      0.30 * Math.max(0, momentumScore) +
      0.20 * agreementScore +
      0.10 * breadthScore
    ));

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 10: False Breakout Risk (0-100)
    // High movement + low breadth + low agreement = high false breakout risk
    // Formula mirrors chaos_score approach: product of contributing factors
    // ═══════════════════════════════════════════════════════════════════════
    const falseBreakoutRisk = round1(
      (movementScore / 100) * (1 - breadthScore / 100) * (1 - agreementScore / 100) * 100
    );

    // ── Compression & Expansion ────────────────────────────────────────────
    const compressionScore = round1(((100 - movementScore) * (100 - breadthScore)) / 100);

    // ═══════════════════════════════════════════════════════════════════════
    // ENGINE 11: Expansion Readiness (per PDF formula)
    // readiness = 0.35×compression_persistence + 0.20×volatility_contraction
    //           + 0.20×participation_expansion + 0.15×session_transition_quality
    //           + 0.10×alignment_improvement
    // ═══════════════════════════════════════════════════════════════════════
    const compPersistence  = Math.min(100, compressionStreak * 25);
    const volContraction   = Math.max(0, 100 - volatilityScore);
    const partExpansion    = prevHourScores
      ? Math.min(100, Math.max(0, 50 + (breadthScore - (prevHourScores.breadth || 50)) * 3))
      : 50;
    const sessTransQuality = SESSION_QUALITY_SCORE[session] || 50;
    const alignImprove     = prevHourScores
      ? Math.min(100, Math.max(0, 50 + (agreementScore - (prevHourScores.agreement || 0)) * 2))
      : 50;
    const expansionReadiness = round1(Math.min(100,
      0.35 * compPersistence +
      0.20 * volContraction +
      0.20 * partExpansion +
      0.15 * sessTransQuality +
      0.10 * alignImprove
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
      time_utc:              hk,
      session_name:          session,
      // Engine 1: Movement
      movement_score:        movementScore,
      movement_magnitude:    round1(avgHourlyMove * 10000),
      // Engine 2: Momentum
      momentum_score:        momentumScore,
      momentum_type:         momentumType,
      // Engine 3: Agreement
      agreement_score:       agreementScore,
      directional_agreement: agreementScore,
      // Engine 4: Volatility Quality
      volatility_score:      volatilityScore,
      volatility_quality:    volatilityQuality,
      volatility_type:       volatilityType,
      chaos_score:           chaosScore,
      // Engine 5: Directional Pressure
      directional_control:   directionalControl,
      bullish_breadth:       bullishPressurePct,
      bearish_breadth:       bearishPressurePct,
      dominance_score:       directionalControl, // alias for backward compat
      // Engine 6: Participation
      breadth_score:         breadthScore,
      pairs_moving:          activePairs,
      pairs_quiet:           TOTAL - activePairs,
      // Engine 7: Currency Leadership
      currency_leadership_gap: currencyLeadershipGap,
      strongest_ccy:         strongestCcy,
      weakest_ccy:           weakestCcy,
      // Engine 8: Market Energy
      energy_base:           energyBase,
      market_energy:         marketEnergy,
      acceleration:          acceleration,
      // Engine 9: Tradability
      tradability_score:     tradabilityScore,
      // Engine 10: False Breakout
      false_breakout_risk:   falseBreakoutRisk,
      // Engine 11: Expansion Readiness
      compression_score:     compressionScore,
      expansion_score:       round1((movementScore * breadthScore) / 100),
      expansion_readiness:   expansionReadiness,
      compression_streak:    compressionStreak,
      // Engine 12: Energy Cycle
      energy_cycle:          energyCycle,
      // Engine 13: Directional Efficiency
      de_score:              deScore,
      // Engine 14: Currency Dispersion
      dispersion_score:      dispersionScore,
    });

    // Track for next hour's momentum calculation
    prevHourScores = {
      movement:   movementScore,
      momentum:   momentumScore,
      volatility: volatilityScore,
      breadth:    breadthScore,
      agreement:  agreementScore,
    };
    prevCandles = candles;
  }

  return onlyLast ? rows.slice(-1) : rows;
}

// ─── Hourly upsert column filter ─────────────────────────────────────────────

function _modal(arr) {
  if (!arr.length) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Fields that exist as columns in hourly_session_activity.
const HOURLY_COLS = new Set([
  'time_utc', 'session_name',
  'movement_score', 'breadth_score', 'agreement_score', 'volatility_score',
  'energy_base', 'acceleration', 'compression_score', 'expansion_score',
  'market_energy', 'expansion_readiness', 'energy_cycle',
  'compression_streak', 'pairs_moving', 'pairs_quiet',
  'movement_magnitude', 'directional_agreement',
  // V2 new columns
  'momentum_score', 'momentum_type',
  'directional_control',
  'volatility_quality', 'volatility_type', 'chaos_score',
  'currency_leadership_gap',
  'tradability_score',
  'false_breakout_risk',
  'de_score',
  'dispersion_score',
]);

function toHourlyRow(r) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => HOURLY_COLS.has(k)));
}

// ─── Tradability grade ──────────────────────────────────────────────────────

function tradabilityGrade(score) {
  if (score >= 70) return 'STRONG_TREND';
  if (score >= 55) return 'TRADABLE';
  if (score >= 40) return 'SELECTIVE';
  if (score >= 25) return 'DANGEROUS';
  return 'AVOID';
}

// ─── Market energy analysis helpers ─────────────────────────────────────────

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

// ─── Fetch currency_strength smooth_3h data for flow pair derivation ─────────
// Returns { time_key → { ccy → smooth_3h } } matching frontend getSmoothed3HFlow()

async function fetchCurrencyStrengthFlow(sinceDays = 14) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  // Paginate — PostgREST caps at 1000 rows per request
  const PAGE = 1000;
  const allData = [];
  let page = 0;
  while (true) {
    const from = page * PAGE;
    const { data, error } = await supabase
      .from('currency_strength')
      .select('time, currency, smooth_3h, smooth_6h')
      .gte('time', since)
      .order('time', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.warn('[SESSION_ACTIVITY] currency_strength fetch:', error.message); break; }
    if (!data?.length) break;
    allData.push(...data);
    if (data.length < PAGE) break;
    page++;
  }
  if (!allData.length) return null;

  // Index by floored-hour time → { ccy → { s3h, s6h } }
  const index = {};
  for (const r of allData) {
    const t = (r.time || '').slice(0, 16).replace(' ', 'T');
    if (!index[t]) index[t] = {};
    index[t][r.currency] = {
      s3h: parseFloat(r.smooth_3h) || 0,
      s6h: parseFloat(r.smooth_6h) || 0,
    };
  }
  return index;
}

async function fetchM15FlowIndex(sinceDays = 14) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  // Paginate — PostgREST caps at 1000 rows per request
  const PAGE = 1000;
  const allData = [];
  let page = 0;
  while (true) {
    const from = page * PAGE;
    const { data, error } = await supabase
      .from('m15_pair_spreads')
      .select('time, instrument, smooth_45m, smooth_90m, smooth_180m, state')
      .gte('time', since)
      .order('time', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.warn('[SESSION_ACTIVITY] m15_pair_spreads fetch:', error.message); break; }
    if (!data?.length) break;
    allData.push(...data);
    if (data.length < PAGE) break;
    page++;
  }
  if (!allData.length) return null;

  // Index by floored-hour time → { instrument → { v45, v90, v180, state } }
  const index = {};
  for (const r of allData) {
    const t = (r.time || '').slice(0, 16).replace(' ', 'T');
    if (!index[t]) index[t] = {};
    index[t][r.instrument] = {
      v45:  parseFloat(r.smooth_45m)  || 0,
      v90:  parseFloat(r.smooth_90m)  || 0,
      v180: parseFloat(r.smooth_180m) || 0,
      state: r.state,
    };
  }
  return index;
}

/**
 * Compute Directional Efficiency from raw candles.
 * DE = (|final_close - initial_open| / sum(high - low)) × 100
 */
function computeDE(candles) {
  if (!candles || candles.length < 2) return 0;
  const netMove = Math.abs(candles[candles.length - 1].close - candles[0].open);
  let totalTravel = 0;
  for (const c of candles) totalTravel += c.high - c.low;
  if (totalTravel === 0) return 0;
  return Math.min(100, (netMove / totalTravel) * 100);
}

async function fetchM15Candles(sinceDays = 14) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const PAGE = 1000;
  const allData = [];
  let page = 0;
  while (true) {
    const from = page * PAGE;
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('instrument, time, open, high, low, close')
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .gte('time', since)
      .order('time', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.warn('[SESSION_ACTIVITY] M15 candles fetch:', error.message); break; }
    if (!data?.length) break;
    allData.push(...data);
    if (data.length < PAGE) break;
    page++;
  }
  if (!allData.length) return null;

  // Group by instrument, sorted ascending
  const byPair = {};
  for (const c of allData) {
    if (!byPair[c.instrument]) byPair[c.instrument] = [];
    byPair[c.instrument].push({
      open: parseFloat(c.open), high: parseFloat(c.high),
      low: parseFloat(c.low), close: parseFloat(c.close), time: c.time,
    });
  }
  return byPair;
}

const FLOW_PAIRS_SET = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
]);

/**
 * Compute flow currencies using the full Flow Performance method:
 * 1. Select top 2 strong / bottom 2 weak by smooth_3h
 * 2. Build flow pairs
 * 3. Score each pair using M15 (smooth_45m) + 3H spread + 6H spread
 * 4. Return strongest/weakest currencies (same as frontend renderFlowPerformance)
 *
 * @param {object} csSnap  - { ccy → { s3h, s6h } } currency strength snapshot
 * @param {object} m15Snap - { instrument → { v45, v90, v180, state } } M15 snapshot (nullable)
 * @returns {{ strong: string, weak: string } | null}
 */
function _flowFromFullMethod(csSnap, m15Snap) {
  if (!csSnap || Object.keys(csSnap).length < 4) return null;

  // Step 1: Select currencies by smooth_3h (matches getSmoothed3HFlow)
  const scored = Object.entries(csSnap)
    .map(([ccy, v]) => ({ ccy, s3h: v.s3h, s6h: v.s6h }))
    .sort((a, b) => b.s3h - a.s3h);
  const strong = scored.slice(0, 2).map(e => e.ccy);
  const weak   = scored.slice(-2).map(e => e.ccy);

  // Step 2: Build flow pairs (strong vs weak)
  const flowPairs = [];
  for (const st of strong) {
    for (const wk of weak) {
      if (st === wk) continue;
      const fwd = `${st}_${wk}`;
      const rev = `${wk}_${st}`;
      if (FLOW_PAIRS_SET.has(fwd))      flowPairs.push({ instrument: fwd, dir: 'BUY',  base: st, quote: wk });
      else if (FLOW_PAIRS_SET.has(rev)) flowPairs.push({ instrument: rev, dir: 'SELL', base: wk, quote: st });
    }
  }

  if (!flowPairs.length) return { strong: strong.join(','), weak: weak.join(',') };

  // Step 3: Score each pair using M15 + 3H + 6H (mirrors frontend perfScore)
  const pairScores = flowPairs.map(fp => {
    const [base, quote] = fp.instrument.split('_');
    const flowSign = fp.dir === 'BUY' ? 1 : -1;

    // M15 data
    const m15 = m15Snap ? m15Snap[fp.instrument] : null;
    const v45  = m15 ? m15.v45  : null;
    const v90  = m15 ? m15.v90  : null;

    // 3H + 6H spreads from currency strength
    const h3Base  = csSnap[base]  ? csSnap[base].s3h  : null;
    const h3Quote = csSnap[quote] ? csSnap[quote].s3h : null;
    const h6Base  = csSnap[base]  ? csSnap[base].s6h  : null;
    const h6Quote = csSnap[quote] ? csSnap[quote].s6h : null;
    const spread3H = (h3Base != null && h3Quote != null) ? h3Base - h3Quote : null;
    const spread6H = (h6Base != null && h6Quote != null) ? h6Base - h6Quote : null;

    // Alignment checks
    const m15Confirms = v45 != null ? Math.sign(v45) === flowSign : null;
    const h3Confirms  = spread3H != null ? Math.sign(spread3H) === flowSign : null;
    const h6Confirms  = spread6H != null ? Math.sign(spread6H) === flowSign : null;

    // M15 acceleration
    const accel = (v45 != null && v90 != null) ? v45 - v90 : null;
    const accelSign = accel != null ? Math.sign(accel) === flowSign : null;

    // Performance score (same weights as frontend)
    let perfScore = 0;
    if (v45 != null)     perfScore += (v45 * flowSign) * 10000 * 4;       // M15 heaviest
    if (spread3H != null) perfScore += (spread3H * flowSign) * 10000 * 2; // 3H
    if (spread6H != null) perfScore += (spread6H * flowSign) * 10000 * 1; // 6H
    if (m15Confirms)     perfScore += 15;
    if (h3Confirms)      perfScore += 10;
    if (h6Confirms)      perfScore += 5;
    if (accelSign)       perfScore += 10;

    // State bonus (from M15)
    if (m15) {
      let state = null;
      if (v45 != null && v90 != null) {
        const dir45 = v45 * flowSign;
        const dir90 = v90 * flowSign;
        if (Math.abs(v45) < 0.00005)                state = 'FLAT';
        else if (dir45 < 0)                          state = 'REVERSING';
        else if (dir45 > dir90 * 1.1)                state = 'EXPANDING';
        else if (dir45 < dir90 * 0.85 && dir90 > 0) state = 'COMPRESSING';
        else                                         state = 'STEADY';
      }
      if (state === 'EXPANDING' && m15Confirms)    perfScore += 15;
      if (state === 'REVERSING')                   perfScore -= 10;
      if (state === 'COMPRESSING' && !m15Confirms) perfScore -= 15;
    }

    return { ...fp, perfScore, m15Confirms, h3Confirms, h6Confirms };
  });

  // Step 4: If all pairs score negative → currencies not truly confirmed
  // Re-derive strongest/weakest from best-scoring pair directions
  pairScores.sort((a, b) => b.perfScore - a.perfScore);

  // Use the 3H-derived currencies (same as frontend — 3H picks, M15+6H validates)
  return { strong: strong.join(','), weak: weak.join(',') };
}

/**
 * Build flow performance pair details for a session (stored in details.flow_performance).
 * Reads from the pre-computed flow_performance table (written by calculateFlowPerformance)
 * which runs earlier in the pipeline. Falls back to legacy CS-based calculation if no data.
 */
async function _flowPerfForSession(g) {
  // Get time range for this session
  const sessionTimes = g.rows.map(r => r.time_utc).filter(Boolean).sort();
  if (!sessionTimes.length) return null;

  const firstHour = sessionTimes[0].slice(0, 13) + ':00:00';
  const lastHour  = sessionTimes[sessionTimes.length - 1].slice(0, 13) + ':00:00';

  // Read pre-computed flow_performance for this session's time range
  const { data: fpRows, error } = await supabase
    .from('flow_performance')
    .select('instrument, dir, status, state, momentum, perf_score, final_score, de_combined, spread_3h, spread_6h, v45, v90, vol_rv, vol_eff, vol_grade, vol_pers, impulse_score, impulse_aligned, time')
    .gte('time', firstHour)
    .lte('time', lastHour)
    .order('time', { ascending: false })
    .limit(200);

  if (error || !fpRows?.length) return null;

  // Group by instrument, take latest entry for each
  const byInst = {};
  for (const r of fpRows) {
    if (!byInst[r.instrument]) byInst[r.instrument] = r;
  }

  // Sort by final_score descending, take top entries
  const sorted = Object.values(byInst).sort((a, b) => (b.final_score || 0) - (a.final_score || 0));

  return sorted.slice(0, 6).map(r => ({
    pair:   r.instrument,
    dir:    r.dir,
    status: r.status || 'WAIT',
    m15:    r.v45,
    h3:     r.spread_3h,
    h6:     r.spread_6h,
    de:     r.de_combined || 0,
    state:  r.state,
    momentum: r.momentum,
    perf_score:  r.perf_score,
    final_score: r.final_score,
    vol_grade:   r.vol_grade,
    vol_rv:      r.vol_rv,
    impulse_score:   r.impulse_score,
    impulse_aligned: r.impulse_aligned,
  }));
}

/**
 * Look up flow currencies for a session group using the full Flow Performance
 * method (3H selection + M15 + 6H scoring). Falls back to hourly candle-based
 * modal if no currency_strength / m15 data is available for that time.
 *
 * Tries the session's last hour first, then walks backwards through session hours.
 */
function _flowCcyForSession(g, csFlowIndex, m15FlowIndex, side) {
  if (csFlowIndex) {
    // Try each hour in the session (last → first) to find a CS snapshot
    const hours = g.rows.map(r => (r.time_utc || '').slice(0, 16).replace(' ', 'T')).reverse();
    for (const t of hours) {
      const csSnap  = csFlowIndex[t];
      if (!csSnap) continue;
      const m15Snap = m15FlowIndex ? m15FlowIndex[t] : null;
      const flow = _flowFromFullMethod(csSnap, m15Snap);
      if (flow) return flow[side] || null;
    }
  }
  // Fallback: candle-based modal from hourly rows
  const field = side === 'strong' ? 'strongest_ccy' : 'weakest_ccy';
  return _modal(g.rows.map(r => r[field]).filter(Boolean)) || null;
}

// ─── Build per-session rows for market_energy_sessions ──────────────────────

async function buildSessionRows(hourRows, csFlowIndex, m15FlowIndex, m15CandlesByPair) {
  const groups = {};
  for (const r of hourRows) {
    let date = r.time_utc.slice(0, 10);
    // ASIA wraps midnight (23:00–07:00): hour 23 belongs to next day's ASIA session
    if (r.session_name === 'ASIA') {
      const h = new Date(r.time_utc).getUTCHours();
      if (h === 23) {
        const next = new Date(r.time_utc);
        next.setUTCDate(next.getUTCDate() + 1);
        date = next.toISOString().slice(0, 10);
      }
    }
    const key  = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, rows: [] };
    groups[key].rows.push(r);
  }

  const sortedKeys  = Object.keys(groups).sort();
  const sessHistory = {};
  let prevFlowBullPct = 50;

  return Promise.all(sortedKeys.map(async key => {
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

    // New V2 metrics — session averages
    const momAvg     = round1(avg(n('momentum_score')));
    const dirCtrl    = round1(avg(n('directional_control')));
    const volQual    = round1(avg(n('volatility_quality')));
    const chaosAvg   = round1(avg(n('chaos_score')));
    const tradAvg    = round1(avg(n('tradability_score')));
    const leaderGap  = avg(g.rows.map(r => parseFloat(r.currency_leadership_gap) || 0));

    // Session-level volatility type: most frequent hourly type
    const volTypes = g.rows.map(r => r.volatility_type).filter(Boolean);
    const sessVolType = _modal(volTypes) || 'NORMAL';

    // Session-level false breakout risk: average of hourly scores
    const fbrAvg = round1(avg(n('false_breakout_risk')));

    // Pull same-session history
    const hist     = sessHistory[g.session] || [];
    const prevHist = hist[hist.length - 1];

    const accel = prevHist ? round1(eng - prevHist.energy) : 0;

    const sessionCycle = classifyEnergyCycle(
      mov, brd, agr, vol, streak, accel,
      prevHist ? { movement: prevHist.movement, breadth: prevHist.breadth } : null,
      g.session
    );

    // ── Liquidity score ──────────────────────────────────────────────────────
    const bullPct  = round1(avg(n('bullish_breadth')));
    const bearPct  = round1(avg(n('bearish_breadth')));

    const breadthCoherence = mov > 0 ? Math.min(1, brd / mov) : 0;
    const eMagnitude       = Math.min(100, eng);
    const directionalBias  = Math.abs(bullPct - 50) / 50;
    const currDominant     = bullPct >= bearPct ? 'bull' : 'bear';
    const prevFlowDominant = prevFlowBullPct >= 50 ? 'bull' : 'bear';
    const flowPersistence  = currDominant === prevFlowDominant ? 1.0 : 0.6;

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
      // Core scores
      movement_score:      mov,
      breadth_score:       brd,
      agreement_score:     agr,
      volatility_score:    vol,
      // V2 new engines
      momentum_score:          momAvg,
      directional_control:     dirCtrl,
      volatility_quality:      volQual,
      volatility_type:         sessVolType,
      chaos_score:             chaosAvg,
      currency_leadership_gap: round1(leaderGap * 10000) / 10000,
      tradability_score:       tradAvg,
      tradability_grade:       tradabilityGrade(tradAvg),
      false_breakout_risk:     fbrAvg,
      // Existing fields
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
      dominance_score:     dirCtrl,
      strongest_ccy:       _flowCcyForSession(g, csFlowIndex, m15FlowIndex, 'strong'),
      weakest_ccy:         _flowCcyForSession(g, csFlowIndex, m15FlowIndex, 'weak'),
      details: {
        hours: g.rows.length,
        flow_method: csFlowIndex ? 'smooth_3h+6h+m15' : 'candle_modal',
        flow_performance: await _flowPerfForSession(g),
        hourly: g.rows.map(r => ({
          time:                r.time_utc,
          energy_cycle:        r.energy_cycle,
          market_energy:       r.market_energy,
          expansion_readiness: r.expansion_readiness,
          momentum_type:       r.momentum_type,
          tradability_score:   r.tradability_score,
          volatility_type:     r.volatility_type,
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
      const energyDelta = eng - prevHist.energy;
      row.energy_momentum = energyDelta > 5  ? 'ACCELERATING'
                          : energyDelta < -5 ? 'DECELERATING'
                          :                    'STABLE';
    }

    if (!sessHistory[g.session]) sessHistory[g.session] = [];
    sessHistory[g.session].push({ movement: mov, breadth: brd, agreement: agr, volatility: vol, energy: eng, bullPct });

    return row;
  }));
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
      'momentum_score', 'directional_control', 'tradability_score',
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

    const hist    = sessionHistory[g.session] || [];
    const histAvg = hist.slice(-10).length > 0 ? arrAvg(hist.slice(-10)) : avgMov;
    const expComp = round1(Math.min(100, (histAvg > 0 ? avgMov / histAvg : 1.0) * 50));
    if (!sessionHistory[g.session]) sessionHistory[g.session] = [];
    sessionHistory[g.session].push(avgMov);

    const energyScore = Math.min(100, Math.round(
      0.40 * avgMov + 0.35 * avgBrd + 0.15 * expComp + 0.10 * avgAgr
    ));
    let energyState = energyScore <= 15 ? 'DEAD'
                    : energyScore <= 35 ? 'COMPRESSION'
                    : energyScore <= 55 ? 'STABLE'
                    : energyScore <= 75 ? 'EXPANSION' : 'EXPLOSIVE';
    if (avgBrd < 50 && (energyState === 'EXPANSION' || energyState === 'EXPLOSIVE')) energyState = 'STABLE';

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
      avg_movement_score:        round1(avgMov),
      avg_breadth_score:         round1(avgBrd),
      avg_directional_agreement: round1(avgAgr),
      avg_agreement_score:       round1(avgAgr),
      avg_volatility_score:      round1(avgVol),
      avg_energy_base:           round1(avgEB),
      avg_acceleration:          round1(avgAcc),
      avg_market_energy:         round1(avgEnergy),
      avg_expansion_readiness:   round1(avgReady),
      expansion_score:           expComp,
      session_energy_score:      energyScore,
      session_state:             energyState,
      dominant_cycle:            dominantCycle,
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
  const byTime   = await fetchHourlyCandles(500);
  const hourKeys = Object.keys(byTime).sort();
  if (!hourKeys.length) { console.log('[SESSION_ACTIVITY] No candles.'); return; }

  // Fetch 12H currency strength for dispersion engine
  const csIndex = await _fetchCsStrengthIndex(hourKeys[0]);
  const rows = processHours(hourKeys, byTime, false, csIndex);
  if (!rows.length) return;

  const { error } = await supabase
    .from('hourly_session_activity')
    .upsert(rows.map(toHourlyRow), { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) throw new Error(`Hourly upsert: ${error.message}`);
  console.log(`[SESSION_ACTIVITY] Backfilled ${rows.length} rows.`);

  // Fetch currency strength (3H+6H), M15 spread data, and M15 candles for DE
  const daysCover = Math.ceil(300 / 24 * 1.5);
  const csFlowIndex    = await fetchCurrencyStrengthFlow(daysCover);
  const m15FlowIndex   = await fetchM15FlowIndex(daysCover);
  const m15CandleData  = await fetchM15Candles(daysCover);
  const allSessionRows = await buildSessionRows(rows, csFlowIndex, m15FlowIndex, m15CandleData);

  if (fullRewrite) {
    await upsertMarketEnergySessions(allSessionRows);
  } else {
    const { getCurrentSession } = require('./sessionEngine');
    const activeSession = getCurrentSession().session;
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRows = allSessionRows.filter(sr => sr.session_date === todayStr);

    if (todayRows.length) {
      // Always upsert ALL of today's sessions — previous sessions may have
      // gained new hourly bars since their last upsert (e.g. LONDON's final
      // hour arrives after NEW_YORK becomes the active session).
      await upsertMarketEnergySessions(todayRows);
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

  const csIndex = await _fetchCsStrengthIndex(hourKeys[0]);
  const allRows = processHours(hourKeys, byTime, false, csIndex);
  const row = allRows[allRows.length - 1];
  if (!row) return;

  const { error } = await supabase
    .from('hourly_session_activity')
    .upsert([toHourlyRow(row)], { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) throw new Error(`Hourly upsert: ${error.message}`);

  const { getCurrentSession } = require('./sessionEngine');
  const activeSession = getCurrentSession().session;
  const todayStr = new Date().toISOString().slice(0, 10);

  // Fetch currency strength (3H+6H), M15 spread data, and M15 candles for DE
  const csFlowIndex   = await fetchCurrencyStrengthFlow(2);
  const m15FlowIndex  = await fetchM15FlowIndex(2);
  const m15CandleData = await fetchM15Candles(2);
  const sessionRows = await buildSessionRows(allRows, csFlowIndex, m15FlowIndex, m15CandleData);
  const currentOnly = sessionRows.filter(
    sr => sr.session_name === activeSession && sr.session_date === todayStr
  );
  if (currentOnly.length) {
    await upsertMarketEnergySessions(currentOnly);
  }

  console.log(
    `[SESSION_ACTIVITY] ✓ ${row.time_utc} | ${row.session_name} | ${row.energy_cycle}` +
    ` | energy:${row.market_energy} trad:${row.tradability_score} mom:${row.momentum_score}(${row.momentum_type})` +
    ` | mov:${row.movement_score} brd:${row.breadth_score} agr:${row.agreement_score} vol:${row.volatility_score}` +
    ` | dirCtrl:${row.directional_control} volQ:${row.volatility_quality}(${row.volatility_type})` +
    ` | acc:${row.acceleration >= 0 ? '+' : ''}${row.acceleration} streak:${row.compression_streak}`
  );

  await computeSessionSummaries();
  return row;
}

// ─── Market energy report ───────────────────────────────────────────────────

async function getMarketEnergyData() {
  const { getCurrentSession } = require('./sessionEngine');
  const currentSession = getCurrentSession().session;
  const todayStr = new Date().toISOString().slice(0, 10);

  // Try today, then fall back to the most recent available date
  let targetDate = todayStr;
  let { data: dbSessions, error: dbErr } = await supabase
    .from('market_energy_sessions')
    .select('*')
    .eq('session_date', todayStr)
    .order('session_name', { ascending: true });

  if (dbErr) console.warn('[ME] DB read error:', dbErr.message);

  if (!dbSessions?.length) {
    // No data today — find the most recent date with data
    const { data: latest, error: latErr } = await supabase
      .from('market_energy_sessions')
      .select('session_date')
      .neq('session_name', 'LOW_LIQUIDITY')
      .order('session_date', { ascending: false })
      .limit(1);
    if (latErr) console.warn('[ME] Latest date lookup error:', latErr.message);
    const latestDate = latest?.[0]?.session_date;
    if (!latestDate) return null;

    const { data: fallback, error: fbErr } = await supabase
      .from('market_energy_sessions')
      .select('*')
      .eq('session_date', latestDate)
      .order('session_name', { ascending: true });
    if (fbErr) console.warn('[ME] Fallback read error:', fbErr.message);
    if (!fallback?.length) return null;
    dbSessions = fallback;
    targetDate = latestDate;
  }

  const storedByName = {};
  for (const row of dbSessions) {
    if (row.details && typeof row.details === 'object') {
      const { hours, hourly, ...computed } = row.details;
      Object.assign(row, computed);
      row.details = { hours, hourly };
    }
    storedByName[row.session_name] = row;
  }

  const sessions = SESSION_ORDER.map(n => storedByName[n]).filter(Boolean);

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
