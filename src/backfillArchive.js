'use strict';

/**
 * Backfill hourly_session_activity + market_energy_sessions from backtest_candles.
 * V2 — Institutional Calculation Model (mirrors sessionActivity.js engines).
 *
 * Usage:
 *   node src/backfillArchive.js                 # full 12-month backfill
 *   node src/backfillArchive.js --from 2025-09  # from September 2025
 *   node src/backfillArchive.js --days 30       # last 30 days only
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { config }            = require('./config');
const { getCurrentSession } = require('./sessionEngine');

// ── DB ──────────────────────────────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Helpers ─────────────────────────────────────────────────────────────────

function round1(v)  { return Math.round(v * 10) / 10; }
function ri(v)      { return Math.round(parseFloat(v) || 0); }
function arrAvg(a)  { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

function pctVsRef(current, ref) {
  if (!ref) return null;
  const pct = Math.round((current / ref - 1) * 100);
  return Math.abs(pct) > 200 ? null : pct;
}

function geoMean(vals) {
  if (!vals.length) return 0;
  if (vals.some(v => v <= 0)) return 0;
  const logSum = vals.reduce((s, v) => s + Math.log(v), 0);
  return Math.exp(logSum / vals.length);
}

const CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

function computeCurrencyStrengths(candles, sessionOpenPrices) {
  const sums = {}, counts = {};
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

function classifyHour(isoTime) {
  return getCurrentSession(new Date(isoTime)).session;
}

// ── Calibrated thresholds ──────────────────────────────────────────────────

const SESSION_QUALITY_SCORE = { LOW_LIQUIDITY: 0, ASIA: 45, LONDON: 80, NEW_YORK: 80 };

const SESSION_SCALE = {
  ASIA:     { movementCap: 0.0012, volatilityCap: 0.0020, breadthThreshold: 0.00015 },
  LONDON:   { movementCap: 0.0015, volatilityCap: 0.0025, breadthThreshold: 0.00020 },
  NEW_YORK: { movementCap: 0.0018, volatilityCap: 0.0030, breadthThreshold: 0.00020 },
  DEFAULT:  { movementCap: 0.0015, volatilityCap: 0.0025, breadthThreshold: 0.00020 },
};

// ── Momentum classification ─────────────────────────────────────────────────

function classifyMomentum(momentumScore, momentumAccel, movementScore) {
  if (momentumScore > 15 && movementScore >= 50) return 'IMPULSE';
  if (momentumScore > 5 && momentumAccel > 2) return 'EXPANSION';
  if (movementScore >= 40 && momentumScore < -5) return 'EXHAUSTION';
  if (momentumScore > 3) return 'TREND';
  if (momentumScore < -3) return 'DECAY';
  return 'STABLE';
}

// ── Volatility classification ───────────────────────────────────────────────

function classifyVolatility(volScore, agrScore, dirControl, prevVolScore) {
  if (prevVolScore != null && volScore > prevVolScore * 1.8 && volScore >= 50) return 'EVENT';
  if (volScore >= 55) {
    if (agrScore >= 45 && dirControl >= 35) return 'HEALTHY';
    if (agrScore < 30 || dirControl < 20) return 'CHAOTIC';
    return 'HEALTHY';
  }
  if (volScore >= 25) return 'NORMAL';
  return 'DEAD';
}

function computeVolatilityQuality(volScore, volType) {
  const mult = { HEALTHY: 1.0, NORMAL: 0.75, EVENT: 0.50, CHAOTIC: 0.30, DEAD: 0.20 };
  return round1(volScore * (mult[volType] || 0.5));
}

// ── Energy cycle ────────────────────────────────────────────────────────────

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

// ── Tradability grade ───────────────────────────────────────────────────────

function tradabilityGrade(score) {
  if (score >= 70) return 'STRONG_TREND';
  if (score >= 55) return 'TRADABLE';
  if (score >= 40) return 'SELECTIVE';
  if (score >= 25) return 'DANGEROUS';
  return 'AVOID';
}

// ── Core processHours — V2 institutional model ─────────────────────────────

function processHours(hourKeys, byTime) {
  const TOTAL = config.instruments.length;

  let currentSession    = null;
  let sessionOpenPrices = {};
  let sessionHigh       = {};
  let sessionLow        = {};

  const prevSameSessionEnergy = {};
  const prevSameSessionScores = {};
  let compressionStreak = 0;

  let sessionEBList  = [];
  let sessionMovList = [];
  let sessionBrdList = [];
  let sessionAgrList = [];
  let sessionVolList = [];

  let prevHourScores = null;

  const rows = [];

  for (const hk of hourKeys) {
    const candles = byTime[hk];
    const session = classifyHour(hk);

    if (session !== currentSession) {
      if (currentSession && currentSession !== 'LOW_LIQUIDITY') {
        const avgMov = arrAvg(sessionMovList);
        const avgBrd = arrAvg(sessionBrdList);
        const avgVol = arrAvg(sessionVolList);

        if (avgMov < 35 && avgBrd < 35 && avgVol < 40) compressionStreak++;
        else compressionStreak = 0;

        if (sessionEBList.length) prevSameSessionEnergy[currentSession] = arrAvg(sessionEBList);
        prevSameSessionScores[currentSession] = { movement: avgMov, breadth: avgBrd, agreement: arrAvg(sessionAgrList), volatility: avgVol };
      }

      sessionOpenPrices = {};
      sessionHigh       = {};
      sessionLow        = {};
      sessionEBList     = [];
      sessionMovList    = [];
      sessionBrdList    = [];
      sessionAgrList    = [];
      sessionVolList    = [];
      prevHourScores    = null;

      for (const [inst, c] of Object.entries(candles)) {
        sessionOpenPrices[inst] = c.open;
        sessionHigh[inst]       = c.high;
        sessionLow[inst]        = c.low;
      }
      currentSession = session;
    }

    if (session === 'LOW_LIQUIDITY') continue;

    for (const [inst, c] of Object.entries(candles)) {
      if (c.high != null && (sessionHigh[inst] == null || c.high > sessionHigh[inst])) sessionHigh[inst] = c.high;
      if (c.low  != null && (sessionLow[inst]  == null || c.low  < sessionLow[inst]))  sessionLow[inst]  = c.low;
    }

    const scale = SESSION_SCALE[session] || SESSION_SCALE.DEFAULT;
    const ccyStrength = computeCurrencyStrengths(candles, sessionOpenPrices);

    let strongestCcy = null, weakestCcy = null;
    {
      const sorted = Object.entries(ccyStrength).sort((a, b) => b[1] - a[1]);
      if (sorted.length >= 2) {
        strongestCcy = sorted.slice(0, 2).map(e => e[0]).join(',');
        weakestCcy   = sorted.slice(-2).reverse().map(e => e[0]).join(',');
      }
    }

    // Currency Leadership
    const strengthVals = Object.values(ccyStrength).sort((a, b) => b - a);
    const currencyLeadershipGap = strengthVals.length >= 2
      ? round1((strengthVals[0] - strengthVals[strengthVals.length - 1]) * 10000) / 10000
      : 0;

    const hourlyMoves  = [];
    const hourlyRanges = [];
    let activePairs    = 0;
    let bullishMag = 0, bearishMag = 0;
    let agrAligned = 0, agrTotal = 0;
    let ccyAligned = 0, ccyTotal = 0;

    for (const inst of config.instruments) {
      const c    = candles[inst];
      const sOpen = sessionOpenPrices[inst];
      if (!c || !c.open || c.open === 0 || sOpen == null) continue;

      const hourlyDir  = (c.close - c.open) / c.open;
      const hourlyMove = Math.abs(hourlyDir);
      hourlyMoves.push(hourlyMove);

      const hourlyRange = (c.high - c.low) / c.open;
      hourlyRanges.push(hourlyRange);

      if (hourlyMove >= scale.breadthThreshold) {
        activePairs++;
        if (hourlyDir > 0) bullishMag += hourlyMove;
        else               bearishMag += hourlyMove;
      }

      // Pair alignment (hourly vs session direction)
      const sessionDir = (c.close - sOpen) / sOpen;
      if (Math.abs(hourlyDir) >= scale.breadthThreshold * 0.5 &&
          Math.abs(sessionDir) >= scale.breadthThreshold * 0.5) {
        agrTotal++;
        if ((hourlyDir > 0 && sessionDir > 0) || (hourlyDir < 0 && sessionDir < 0)) {
          agrAligned++;
        }
      }

      // Currency alignment
      const [base, quote] = inst.split('_');
      const expectedDir = (ccyStrength[base] || 0) - (ccyStrength[quote] || 0);
      if (Math.abs(hourlyDir) >= scale.breadthThreshold * 0.5 && Math.abs(expectedDir) > 0.00001) {
        ccyTotal++;
        if ((expectedDir > 0 && hourlyDir > 0) || (expectedDir < 0 && hourlyDir < 0)) {
          ccyAligned++;
        }
      }
    }

    if (!hourlyMoves.length) continue;

    // Movement
    const avgHourlyMove = arrAvg(hourlyMoves);
    const movementScore = round1(Math.min(100, (avgHourlyMove / scale.movementCap) * 100));

    // Breadth
    const breadthScore = round1((activePairs / TOTAL) * 100);

    // Agreement (currency × pair alignment)
    const pairAlignment = agrTotal > 0 ? agrAligned / agrTotal : 0;
    const ccyAlignment  = ccyTotal > 0 ? ccyAligned / ccyTotal : 0;
    const rawAgreement   = pairAlignment * ccyAlignment;
    const agreementScore = round1(rawAgreement * Math.sqrt(breadthScore / 100) * 100);

    // Directional Control
    const totalMag           = bullishMag + bearishMag;
    const bullishPressurePct = totalMag > 0 ? round1(bullishMag / totalMag * 100) : 50;
    const bearishPressurePct = totalMag > 0 ? round1(bearishMag / totalMag * 100) : 50;
    const directionalControl = totalMag > 0 ? round1(Math.abs(bullishMag - bearishMag) / totalMag * 100) : 0;

    // Volatility Quality
    const avgHourlyRange  = arrAvg(hourlyRanges);
    const volatilityScore = round1(Math.min(100, (avgHourlyRange / scale.volatilityCap) * 100));
    const volatilityType  = classifyVolatility(
      volatilityScore, agreementScore, directionalControl,
      prevHourScores ? prevHourScores.volatility : null
    );
    const volatilityQuality = computeVolatilityQuality(volatilityScore, volatilityType);
    const chaosScore = round1(
      (volatilityScore / 100) * (1 - agreementScore / 100) * (1 - directionalControl / 100) * 100
    );

    // Momentum
    const momentumScore = prevHourScores ? round1(movementScore - prevHourScores.movement) : 0;
    const momentumAccel = prevHourScores?.momentum != null ? round1(momentumScore - prevHourScores.momentum) : 0;
    const momentumType  = classifyMomentum(momentumScore, momentumAccel, movementScore);

    // Market Energy (PDF formula)
    const energyBase = round1(
      0.30 * movementScore +
      0.25 * breadthScore +
      0.20 * agreementScore +
      0.15 * directionalControl +
      0.10 * volatilityQuality
    );

    const sessionQualityMult = volatilityType === 'CHAOTIC' ? 0.65
                             : volatilityType === 'DEAD'    ? 0.55
                             : volatilityType === 'EVENT'   ? 0.75
                             : volatilityType === 'HEALTHY' ? 1.10
                             :                                0.90;
    const marketEnergy = round1(Math.min(100, energyBase * sessionQualityMult));

    const prevSessEB   = prevSameSessionEnergy[session] ?? null;
    const acceleration = prevSessEB != null ? round1(energyBase - prevSessEB) : 0;

    // Tradability (geometric mean gate)
    const volQualFactor = volatilityType === 'HEALTHY' ? 1.1
                        : volatilityType === 'NORMAL'  ? 0.95
                        : volatilityType === 'EVENT'   ? 0.7
                        : volatilityType === 'CHAOTIC' ? 0.5
                        :                                0.4;
    const tradComponents = [
      Math.max(1, marketEnergy),
      Math.max(1, agreementScore),
      Math.max(1, directionalControl),
      Math.max(1, breadthScore),
    ];
    const tradabilityScore = round1(Math.min(100, geoMean(tradComponents) * volQualFactor));

    // False Breakout Detection
    const falseBreakoutRisk = movementScore >= 35 && breadthScore < 30 && agreementScore < 25;

    // Compression & Expansion Readiness
    const compressionScore = round1(((100 - movementScore) * (100 - breadthScore)) / 100);

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
      0.35 * compPersistence + 0.20 * volContraction + 0.20 * partExpansion + 0.15 * sessTransQuality + 0.10 * alignImprove
    ));

    // Energy Cycle
    const energyCycle = classifyEnergyCycle(
      movementScore, breadthScore, agreementScore, volatilityScore,
      compressionStreak, acceleration, prevSameSessionScores[session] || null, session
    );

    sessionEBList.push(energyBase);
    sessionMovList.push(movementScore);
    sessionBrdList.push(breadthScore);
    sessionAgrList.push(agreementScore);
    sessionVolList.push(volatilityScore);

    rows.push({
      time_utc:              hk,
      session_name:          session,
      movement_score:        movementScore,
      movement_magnitude:    round1(avgHourlyMove * 10000),
      momentum_score:        momentumScore,
      momentum_type:         momentumType,
      agreement_score:       agreementScore,
      directional_agreement: agreementScore,
      volatility_score:      volatilityScore,
      volatility_quality:    volatilityQuality,
      volatility_type:       volatilityType,
      chaos_score:           chaosScore,
      directional_control:   directionalControl,
      bullish_breadth:       bullishPressurePct,
      bearish_breadth:       bearishPressurePct,
      dominance_score:       directionalControl,
      breadth_score:         breadthScore,
      pairs_moving:          activePairs,
      pairs_quiet:           TOTAL - activePairs,
      currency_leadership_gap: currencyLeadershipGap,
      strongest_ccy:         strongestCcy,
      weakest_ccy:           weakestCcy,
      energy_base:           energyBase,
      market_energy:         marketEnergy,
      acceleration,
      tradability_score:     tradabilityScore,
      false_breakout_risk:   falseBreakoutRisk,
      compression_score:     compressionScore,
      expansion_score:       round1((movementScore * breadthScore) / 100),
      expansion_readiness:   expansionReadiness,
      compression_streak:    compressionStreak,
      energy_cycle:          energyCycle,
    });

    prevHourScores = {
      movement:   movementScore,
      momentum:   momentumScore,
      volatility: volatilityScore,
      breadth:    breadthScore,
      agreement:  agreementScore,
    };
  }

  return rows;
}

// ── Hourly column filter ────────────────────────────────────────────────────

const HOURLY_COLS = new Set([
  'time_utc', 'session_name',
  'movement_score', 'breadth_score', 'agreement_score', 'volatility_score',
  'energy_base', 'acceleration', 'compression_score', 'expansion_score',
  'market_energy', 'expansion_readiness', 'energy_cycle',
  'compression_streak', 'pairs_moving', 'pairs_quiet',
  'movement_magnitude', 'directional_agreement',
  'momentum_score', 'momentum_type',
  'directional_control',
  'volatility_quality', 'volatility_type', 'chaos_score',
  'currency_leadership_gap',
  'tradability_score',
  'false_breakout_risk',
]);

function toHourlyRow(r) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => HOURLY_COLS.has(k)));
}

// ── Build session rows ──────────────────────────────────────────────────────

const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
const SESS_NEXT  = { ASIA: 'LONDON', LONDON: 'NEW_YORK', NEW_YORK: 'ASIA' };
const COMPRESSED_CYCLE = new Set(['DEAD', 'COMPRESSION', 'LOW_PARTICIPATION']);

function buildSessionRows(hourRows) {
  const groups = {};
  for (const r of hourRows) {
    const date = r.time_utc.slice(0, 10);
    const key  = `${date}:${r.session_name}`;
    if (!groups[key]) groups[key] = { date, session: r.session_name, rows: [] };
    groups[key].rows.push(r);
  }

  const sortedKeys  = Object.keys(groups).sort();
  const sessHistory = {};
  let prevFlowBullPct = 50;

  return sortedKeys.map(key => {
    const g   = groups[key];
    const n   = field => g.rows.map(r => parseFloat(r[field]) || 0);
    const avg = arr   => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    function _modal(arr) {
      if (!arr.length) return null;
      const counts = {};
      for (const v of arr) counts[v] = (counts[v] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }

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

    // V2 metrics
    const momAvg     = round1(avg(n('momentum_score')));
    const dirCtrl    = round1(avg(n('directional_control')));
    const volQual    = round1(avg(n('volatility_quality')));
    const chaosAvg   = round1(avg(n('chaos_score')));
    const tradAvg    = round1(avg(n('tradability_score')));
    const leaderGap  = avg(g.rows.map(r => parseFloat(r.currency_leadership_gap) || 0));
    const sessVolType = _modal(g.rows.map(r => r.volatility_type).filter(Boolean)) || 'NORMAL';
    const anyFalseBreakout = g.rows.some(r => r.false_breakout_risk);

    const hist     = sessHistory[g.session] || [];
    const prevHist = hist[hist.length - 1];
    const accel = prevHist ? round1(eng - prevHist.energy) : 0;

    const sessionCycle = classifyEnergyCycle(
      mov, brd, agr, vol, streak, accel,
      prevHist ? { movement: prevHist.movement, breadth: prevHist.breadth } : null,
      g.session
    );

    // Liquidity score
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
      movement_score:      mov,
      breadth_score:       brd,
      agreement_score:     agr,
      volatility_score:    vol,
      momentum_score:          momAvg,
      directional_control:     dirCtrl,
      volatility_quality:      volQual,
      volatility_type:         sessVolType,
      chaos_score:             chaosAvg,
      currency_leadership_gap: round1(leaderGap * 10000) / 10000,
      tradability_score:       tradAvg,
      tradability_grade:       tradabilityGrade(tradAvg),
      false_breakout_risk:     anyFalseBreakout,
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
      strongest_ccy:       _modal(g.rows.map(r => r.strongest_ccy).filter(Boolean)),
      weakest_ccy:         _modal(g.rows.map(r => r.weakest_ccy).filter(Boolean)),
      details: {
        hours: g.rows.length,
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

    if (!sessHistory[g.session]) sessHistory[g.session] = [];
    sessHistory[g.session].push({ movement: mov, breadth: brd, agreement: agr, volatility: vol, energy: eng, bullPct });

    return row;
  });
}

// ── Fetch all H1 candles ───────────────────────────────────────────────────

async function fetchBacktestCandles(fromDate) {
  console.log(`[ARCHIVE] Fetching H1 candles from backtest_candles since ${fromDate || 'all'}…`);

  const byTime = {};
  let totalFetched = 0;

  for (const instrument of config.instruments) {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      let query = supabase
        .from('backtest_candles')
        .select('time, open, high, low, close')
        .eq('instrument', instrument)
        .eq('timeframe', 'H1')
        .eq('complete', true)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);

      if (fromDate) {
        query = query.gte('time', fromDate);
      }

      const { data, error } = await query;
      if (error) { console.error(`  ${instrument}: ${error.message}`); break; }
      if (!data || !data.length) break;

      for (const c of data) {
        const t = new Date(c.time).toISOString();
        if (!byTime[t]) byTime[t] = {};
        byTime[t][instrument] = {
          open:  parseFloat(c.open),
          close: parseFloat(c.close),
          high:  parseFloat(c.high),
          low:   parseFloat(c.low),
        };
      }
      totalFetched += data.length;
      if (data.length < PAGE) break;
      offset += PAGE;
    }
  }

  console.log(`[ARCHIVE] Loaded ${totalFetched.toLocaleString()} candles across ${Object.keys(byTime).length} hours`);
  return byTime;
}

// ── Upsert in batches ───────────────────────────────────────────────────────

const BATCH = 500;

async function upsertHourlyBatched(rows) {
  let stored = 0;
  const hourlyRows = rows.map(toHourlyRow);
  for (let i = 0; i < hourlyRows.length; i += BATCH) {
    const batch = hourlyRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('hourly_session_activity')
      .upsert(batch, { onConflict: 'time_utc', ignoreDuplicates: false });
    if (error) throw new Error(`hourly_session_activity upsert: ${error.message}`);
    stored += batch.length;
  }
  return stored;
}

async function upsertSessionBatched(sessionRows) {
  let stored = 0;
  const SESSION_INMEM = new Set([
    'norm_movement', 'norm_breadth', 'norm_agreement', 'norm_volatility', 'norm_energy',
    'baseline_n', 'prev_movement', 'prev_breadth', 'prev_agreement', 'prev_energy', 'energy_momentum',
  ]);

  const cleaned = sessionRows.map(r => {
    const computed = {};
    const row = {};
    for (const [k, v] of Object.entries(r)) {
      if (SESSION_INMEM.has(k)) computed[k] = v;
      else row[k] = v;
    }
    if (!row.details) row.details = {};
    row.details = { ...row.details, ...computed };
    return row;
  });

  for (let i = 0; i < cleaned.length; i += BATCH) {
    const batch = cleaned.slice(i, i + BATCH);
    const { error } = await supabase
      .from('market_energy_sessions')
      .upsert(batch, { onConflict: 'session_date,session_name', ignoreDuplicates: false });
    if (error) throw new Error(`market_energy_sessions upsert: ${error.message}`);
    stored += batch.length;
  }
  return stored;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let fromDate = null;

  const fromIdx = args.indexOf('--from');
  if (fromIdx !== -1 && args[fromIdx + 1]) {
    fromDate = args[fromIdx + 1];
    if (!fromDate.includes('T')) fromDate += 'T00:00:00Z';
  }

  const daysIdx = args.indexOf('--days');
  if (daysIdx !== -1 && args[daysIdx + 1]) {
    const days = parseInt(args[daysIdx + 1], 10);
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    fromDate = d.toISOString();
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  NervaFX Archive Backfill V2');
  console.log(`  Source: backtest_candles (H1)`);
  console.log(`  From: ${fromDate || 'all available data'}`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}\n`);

  const t0 = Date.now();

  const byTime   = await fetchBacktestCandles(fromDate);
  const hourKeys = Object.keys(byTime).sort();

  if (!hourKeys.length) {
    console.log('[ARCHIVE] No candle data found. Exiting.');
    return;
  }

  console.log(`[ARCHIVE] Processing ${hourKeys.length} hours through V2 engine…`);

  const rows = processHours(hourKeys, byTime);
  console.log(`[ARCHIVE] Computed ${rows.length} hourly metric rows`);

  const sessionRows = buildSessionRows(rows);
  console.log(`[ARCHIVE] Built ${sessionRows.length} session rows`);

  console.log('[ARCHIVE] Upserting hourly_session_activity…');
  const hourlyStored = await upsertHourlyBatched(rows);
  console.log(`[ARCHIVE] ✓ ${hourlyStored} hourly rows stored`);

  console.log('[ARCHIVE] Upserting market_energy_sessions…');
  const sessionStored = await upsertSessionBatched(sessionRows);
  console.log(`[ARCHIVE] ✓ ${sessionStored} session rows stored`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ARCHIVE BACKFILL V2 COMPLETE — ${elapsed}s`);
  console.log(`  Hourly rows:  ${hourlyStored.toLocaleString()}`);
  console.log(`  Session rows: ${sessionStored.toLocaleString()}`);
  console.log(`${'═'.repeat(60)}\n`);
}

module.exports = { fetchBacktestCandles, processHours, buildSessionRows, toHourlyRow, upsertHourlyBatched, upsertSessionBatched };

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
