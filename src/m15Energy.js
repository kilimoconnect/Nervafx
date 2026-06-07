'use strict';

/**
 * M15 Energy Bars — Lightweight 15-minute energy calculation
 *
 * Computes a simplified market energy score every 15 minutes using M15 candles.
 * Same formula as hourly: 30% dispersion + 25% breadth + 25% agreement + 20% movement
 * × volatility quality modifier.
 *
 * Stores results in `m15_energy_bars` table for frontend charting.
 */

const { supabase }          = require('./supabase');
const { getCurrentSession } = require('./sessionEngine');
const { config }            = require('./config');

const CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

function round1(v) { return Math.round(v * 10) / 10; }
function arrAvg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// Session-calibrated scaling (same as hourly engine, adapted for M15)
const SESSION_SCALE = {
  ASIA:       { movementCap: 0.0006, breadthThreshold: 0.00008 },
  LONDON:     { movementCap: 0.0008, breadthThreshold: 0.00010 },
  NEW_YORK:   { movementCap: 0.0009, breadthThreshold: 0.00010 },
  DEFAULT:    { movementCap: 0.0007, breadthThreshold: 0.00009 },
};

const DISPERSION_CAP = 0.006; // same as hourly engine

// ─── Fetch M15 candles (last N per instrument) ────────────────────────────────

async function fetchM15Candles(limit = 96) {
  const byTime = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', instrument)
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(limit);
    if (error) { console.warn(`[M15-ENERGY] fetch ${instrument}:`, error.message); continue; }
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

// ─── Fetch 12H currency strength for dispersion ──────────────────────────────

async function fetchDispersionStrength(earliest) {
  try {
    const index = {};
    const { data, error } = await supabase
      .from('currency_strength')
      .select('time, currency, smooth_12h')
      .gte('time', earliest)
      .order('time', { ascending: true })
      .limit(5000);
    if (error || !data?.length) return {};
    for (const r of data) {
      // Map M15 candle time to nearest hourly strength key
      const d = new Date(r.time);
      const hk = d.toISOString();
      if (!index[hk]) index[hk] = {};
      index[hk][r.currency] = parseFloat(r.smooth_12h) || 0;
    }
    return index;
  } catch (_) { return {}; }
}

// ─── Get nearest hourly strength for an M15 timestamp ────────────────────────

function getNearestHourlyStrength(csIndex, m15Time) {
  // M15 times: :00, :15, :30, :45 → map to the :00 hour
  const d = new Date(m15Time);
  d.setUTCMinutes(0, 0, 0);
  const hourKey = d.toISOString();
  return csIndex[hourKey] || null;
}

// ─── Compute currency strength from candle moves ─────────────────────────────

function computeCurrencyStrengths(candles) {
  const sums = {}, counts = {};
  for (const ccy of CURRENCIES) { sums[ccy] = 0; counts[ccy] = 0; }
  for (const inst of config.instruments) {
    const [base, quote] = inst.split('_');
    const c = candles[inst];
    if (!c || !c.open || c.open === 0) continue;
    const move = (c.close - c.open) / c.open;
    sums[base]  += move;  counts[base]++;
    sums[quote] -= move;  counts[quote]++;
  }
  const strength = {};
  for (const ccy of CURRENCIES) {
    strength[ccy] = counts[ccy] > 0 ? sums[ccy] / counts[ccy] : 0;
  }
  return strength;
}

// ─── Classify volatility ─────────────────────────────────────────────────────

function classifyVolatility(volScore, agrScore, dirControl) {
  if (volScore >= 55) {
    if (agrScore >= 45 && dirControl >= 35) return 'HEALTHY';
    if (agrScore < 30 || dirControl < 20) return 'CHAOTIC';
    return 'HEALTHY';
  }
  if (volScore >= 25) return 'NORMAL';
  return 'DEAD';
}

// ─── Process a single M15 bar ────────────────────────────────────────────────

function processM15Bar(candles, session, csHourData) {
  const scale = SESSION_SCALE[session] || SESSION_SCALE.DEFAULT;
  const TOTAL = config.instruments.length;

  // Currency strength from this M15 candle
  const ccyStrength = computeCurrencyStrengths(candles);

  // Dispersion: use 12H smoothed strength if available, else candle-level
  const strengthVals = Object.values(ccyStrength).sort((a, b) => b - a);
  let dispersionGap = strengthVals.length >= 2
    ? strengthVals[0] - strengthVals[strengthVals.length - 1]
    : 0;

  if (csHourData && Object.keys(csHourData).length >= 4) {
    const vals12H = Object.values(csHourData).sort((a, b) => b - a);
    dispersionGap = vals12H[0] - vals12H[vals12H.length - 1];
  }
  const dispersionScore = round1(Math.min(100, (dispersionGap / DISPERSION_CAP) * 100));

  // Per-pair calculations
  const moves  = [];
  const ranges = [];
  let activePairs = 0;
  let bullishMag = 0, bearishMag = 0;
  let agrAligned = 0, agrTotal = 0;
  let ccyAligned = 0, ccyTotal = 0;

  for (const inst of config.instruments) {
    const c = candles[inst];
    if (!c || !c.open || c.open === 0) continue;

    const dir  = (c.close - c.open) / c.open;
    const move = Math.abs(dir);
    moves.push(move);

    const range = (c.high - c.low) / c.open;
    ranges.push(range);

    // Breadth
    if (move >= scale.breadthThreshold) {
      activePairs++;
      if (dir > 0) bullishMag += move;
      else         bearishMag += move;
    }

    // Pair agreement (direction consistency with currency strength)
    const [base, quote] = inst.split('_');
    const expectedDir = (ccyStrength[base] || 0) - (ccyStrength[quote] || 0);
    if (move >= scale.breadthThreshold * 0.5 && Math.abs(expectedDir) > 0.00001) {
      ccyTotal++;
      if ((expectedDir > 0 && dir > 0) || (expectedDir < 0 && dir < 0)) ccyAligned++;
    }
    if (move >= scale.breadthThreshold * 0.5) {
      agrTotal++;
      // For M15 single candle, pair alignment = direction matches majority
      if (dir > 0) agrAligned++;
    }
  }

  if (!moves.length) return null;

  // Correct pair alignment: compare against overall direction bias
  const netBias = agrTotal > 0 ? agrAligned / agrTotal : 0.5;
  // If more than 50% bullish, bullish is the direction; otherwise bearish
  const majorityBullish = netBias >= 0.5;
  let agrRealAligned = 0;
  for (const inst of config.instruments) {
    const c = candles[inst];
    if (!c || !c.open || c.open === 0) continue;
    const dir = (c.close - c.open) / c.open;
    if (Math.abs(dir) < scale.breadthThreshold * 0.5) continue;
    if ((majorityBullish && dir > 0) || (!majorityBullish && dir < 0)) agrRealAligned++;
  }
  const pairAlignment = agrTotal > 0 ? agrRealAligned / agrTotal : 0;
  const ccyAlignment  = ccyTotal > 0 ? ccyAligned / ccyTotal : 0;

  // Movement
  const avgMove = arrAvg(moves);
  const movementScore = round1(Math.min(100, (avgMove / scale.movementCap) * 100));

  // Breadth
  const breadthScore = round1((activePairs / TOTAL) * 100);

  // Agreement
  const rawAgreement = pairAlignment * ccyAlignment;
  const agreementScore = round1(rawAgreement * Math.sqrt(breadthScore / 100) * 100);

  // Volatility
  const avgRange = arrAvg(ranges);
  const volatilityCap = scale.movementCap * 1.8;
  const volatilityScore = round1(Math.min(100, (avgRange / volatilityCap) * 100));

  // Directional control
  const totalMag = bullishMag + bearishMag;
  const directionalControl = totalMag > 0
    ? round1(Math.abs(bullishMag - bearishMag) / totalMag * 100) : 0;

  const volatilityType = classifyVolatility(volatilityScore, agreementScore, directionalControl);

  // Market Energy (same formula as hourly)
  const energyBase = round1(
    0.30 * dispersionScore +
    0.25 * breadthScore +
    0.25 * agreementScore +
    0.20 * movementScore
  );

  const qualityMult = volatilityType === 'CHAOTIC' ? 0.65
                    : volatilityType === 'DEAD'    ? 0.55
                    : volatilityType === 'HEALTHY' ? 1.10
                    :                                0.90;
  const marketEnergy = round1(Math.min(100, energyBase * qualityMult));

  return {
    market_energy:    marketEnergy,
    movement_score:   movementScore,
    breadth_score:    breadthScore,
    agreement_score:  agreementScore,
    dispersion_score: dispersionScore,
    volatility_score: volatilityScore,
  };
}

// ─── Main entry: compute & store M15 energy bars ─────────────────────────────

async function calculateM15Energy() {
  console.log('[M15-ENERGY] Computing M15 energy bars…');

  // Fetch last 96 M15 candles (~24h) per pair
  const byTime = await fetchM15Candles(96);
  const timeKeys = Object.keys(byTime).sort();
  if (!timeKeys.length) { console.log('[M15-ENERGY] No M15 candles.'); return; }

  // Fetch 12H currency strength for dispersion
  const csIndex = await fetchDispersionStrength(timeKeys[0]);

  const bars = [];
  for (const tk of timeKeys) {
    const candles = byTime[tk];
    const pairCount = Object.keys(candles).length;
    if (pairCount < 20) continue; // need most pairs

    const d = new Date(tk);
    const session = getCurrentSession(d).session;
    if (session === 'LOW_LIQUIDITY') continue;

    const csHourData = getNearestHourlyStrength(csIndex, tk);
    const result = processM15Bar(candles, session, csHourData);
    if (!result) continue;

    bars.push({
      time_utc:         tk,
      session_name:     session,
      ...result,
    });
  }

  if (!bars.length) { console.log('[M15-ENERGY] No bars computed.'); return; }

  // Upsert (only most recent bars to avoid rewriting old data)
  const { error } = await supabase
    .from('m15_energy_bars')
    .upsert(bars, { onConflict: 'time_utc', ignoreDuplicates: false });
  if (error) console.error('[M15-ENERGY] Upsert error:', error.message);
  else console.log(`[M15-ENERGY] Stored ${bars.length} M15 energy bars.`);

  return bars.length;
}

module.exports = { calculateM15Energy };
