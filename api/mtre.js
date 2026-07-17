'use strict';

/**
 * GET /api/mtre[?anchor=ISO]
 *
 * Market Trend Respect Engine — scans all 28 majors on H1 and M15 and reports
 * three top-line metrics plus a composite Market Health score:
 *
 *   Trend Respect     — per pair, weighted score over last 10 candles:
 *                         40% price on correct side of EMA20
 *                         30% EMA20 on correct side of EMA50
 *                         30% EMA20 slope in trend direction
 *                       MTI = mean of the 28 per-pair scores.
 *   Trend Breadth     — share of pairs with Respect > 80%.
 *   H1/M15 Agreement  — share of pairs whose current-state trend
 *                       (EMA20 vs EMA50) matches on both timeframes.
 *
 *   Market Health = 0.40 * MTI + 0.35 * Breadth + 0.25 * Agreement
 *
 * Classification: TRENDING (≥ 85), GOOD_TREND (70-85), MIXED (50-70),
 * REVERSAL_CHOPPY (< 50).
 */

const { cors, getClient } = require('./_db');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function emaSeries(values, period) {
  if (values.length < period) return new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const out = new Array(period - 1).fill(null);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// ATR14 at candle index i using the standard true-range formula.
function atrAt(candles, i, period) {
  if (i < period) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const c = candles[k];
    const p = candles[k - 1] || c;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    sum += tr;
  }
  return sum / period;
}

// Linear regression slope of an ordered numeric series.
function regressionSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (values[i] - yMean);
    den += dx * dx;
  }
  return num / den;
}

// Piecewise price-position (bell curve on |close - EMA20| / ATR14):
//   0.0  → 40   (price on EMA20 = weak commitment, not healthy trend)
//   0.3  → 90
//   0.6  → 100  (ideal separation for a trending pair)
//   1.0  → 95
//   1.5  → 80
//   2.0  → 55
//   3.0  → 20
//   4.0+ → 0    (extended, mean-revert risk)
// Direction-sidedness is handled by the caller.
function pricePositionScore(distanceInAtr) {
  const d = Math.max(0, distanceInAtr);
  if (d <= 0.3) return 40 + (d / 0.3) * 50;
  if (d <= 0.6) return 90 + ((d - 0.3) / 0.3) * 10;
  if (d <= 1.0) return 100 - ((d - 0.6) / 0.4) * 5;
  if (d <= 1.5) return 95 - ((d - 1.0) / 0.5) * 15;
  if (d <= 2.0) return 80 - ((d - 1.5) / 0.5) * 25;
  if (d <= 3.0) return 55 - ((d - 2.0) / 1.0) * 35;
  if (d <= 4.0) return 20 - ((d - 3.0) / 1.0) * 20;
  return 0;
}

// EMA20-vs-EMA50 separation: saturates at 0.3 ATR (a realistic strong-trend
// spread on H1/M15). Was previously capped at 1 ATR which meant strong trends
// only scored ~30 here.
function emaStackScore(sepInAtr) {
  return Math.min(100, Math.max(0, (sepInAtr / 0.3) * 100));
}

// Regression slope normalised by ATR, saturates at 0.1 ATR per candle → 100.
// Was previously capped at 0.5 ATR/candle which is a slope you almost never
// see on smoothed EMAs — real strong-trend slopes are 0.05-0.10 ATR/candle.
function slopeMagnitudeScore(slopePerCandleNorm) {
  const mag = Math.min(Math.abs(slopePerCandleNorm), 0.10);
  return (mag / 0.10) * 100;
}

function stdDev(vals) {
  if (!vals || !vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((s, x) => s + (x - mean) * (x - mean), 0) / vals.length;
  return Math.sqrt(variance);
}

// Directional Efficiency — the core trend-vs-chop discriminator.
//   DE = |close[N] − close[0]| / Σ|close[i] − close[i-1]|
// A pair moving 100 pips net over a total path of 130 pips → DE = 0.77
// (highly directional). A choppy pair moving 20 pips net over 150 pips of
// travel → DE = 0.13. Multiplied by 100 to sit on the 0-100 scale used by
// the other Market metrics.
function directionalEfficiency(closes, N) {
  if (!closes || closes.length < N + 1) return null;
  const window = closes.slice(-N - 1);
  let path = 0;
  for (let i = 1; i < window.length; i++) path += Math.abs(window[i] - window[i - 1]);
  if (path === 0) return 0;
  const net = Math.abs(window[window.length - 1] - window[0]);
  return Math.round((net / path) * 100);
}

// Per-candle continuous Respect score at index i. Returns null on missing data.
function candleRespect(candles, closes, e20, e50, i, direction) {
  const sig = direction === 'BUY' ? +1 : -1;
  const cur20 = e20[i], cur50 = e50[i];
  if (cur20 == null || cur50 == null) return null;
  const atr = atrAt(candles, i, 14);
  if (!atr) return null;
  const cur = closes[i];

  // 1) Price position — direction-aware. Wrong side of EMA20 → 0.
  const priceDist = (cur - cur20) / atr;
  const posScore = Math.sign(priceDist) === sig ? pricePositionScore(Math.abs(priceDist)) : 0;

  // 2) EMA stack — direction-aware separation in ATRs.
  const stackDist = (cur20 - cur50) / atr;
  const stackScore = Math.sign(stackDist) === sig ? emaStackScore(Math.abs(stackDist)) : 0;

  // 3) EMA20 slope from regression over last 6 EMA20 values (i-5..i).
  const from = Math.max(0, i - 5);
  const win = [];
  for (let k = from; k <= i; k++) if (e20[k] != null) win.push(e20[k]);
  let slpScore = 0;
  if (win.length >= 3) {
    const slope = regressionSlope(win);
    const slopeNorm = slope / atr;
    slpScore = Math.sign(slopeNorm) === sig ? slopeMagnitudeScore(slopeNorm) : 0;
  }

  return 0.35 * posScore + 0.25 * stackScore + 0.40 * slpScore;
}

// Per-pair Trend Respect on OHLC candles.
//   trend = 'BUY' (EMA20 > EMA50 now) or 'SELL' (EMA20 < EMA50 now).
//   respect = mean of the last 10 candle Respect scores (all continuous).
//   persistence = 1 - σ(series) / 100 → measures how steady the score was.
function pairRespect(candles) {
  if (!candles || candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const last = closes.length - 1;
  const curE20 = e20[last], curE50 = e50[last];
  if (curE20 == null || curE50 == null) return null;
  const trend = curE20 > curE50 ? 'BUY' : curE20 < curE50 ? 'SELL' : null;
  if (!trend) return { trend: null, respect: 0, persistence: 0 };

  const N = 10;
  const series = [];
  for (let k = 0; k < N; k++) {
    const idx = last - k;
    if (idx < 20) break;
    const s = candleRespect(candles, closes, e20, e50, idx, trend);
    if (s != null) series.unshift(s);
  }
  if (!series.length) return { trend, respect: 0, persistence: 0, de: 0 };
  const respect = series.reduce((a, b) => a + b, 0) / series.length;
  const persistence = Math.max(0, 1 - stdDev(series) / 100);
  const de = directionalEfficiency(closes, 20) || 0;
  return {
    trend,
    respect: Math.round(respect),
    persistence: Math.round(persistence * 100) / 100,
    de,
  };
}

function classify(health) {
  if (health >= 85) return 'TRENDING';
  if (health >= 70) return 'GOOD_TREND';
  if (health >= 50) return 'MIXED';
  return 'REVERSAL_CHOPPY';
}

async function fetchOHLC(sb, inst, tf, limit, untilIso) {
  let q = sb
    .from('backtest_candles')
    .select('time, open, high, low, close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (untilIso) q = q.lte('time', untilIso);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).reverse().map(c => ({
    open:  parseFloat(c.open),
    high:  parseFloat(c.high),
    low:   parseFloat(c.low),
    close: parseFloat(c.close),
  }));
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const anchorIso = req.query?.anchor
    ? new Date(req.query.anchor).toISOString()
    : null;

  const t0 = Date.now();
  const sb = getClient();
  try {
    const perPair = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      await Promise.all(batch.map(async inst => {
        const [h1Candles, m15Candles] = await Promise.all([
          fetchOHLC(sb, inst, 'H1',  80, anchorIso),
          fetchOHLC(sb, inst, 'M15', 80, anchorIso),
        ]);
        perPair[inst] = {
          h1:  pairRespect(h1Candles),
          m15: pairRespect(m15Candles),
        };
      }));
    }

    // Roll up across the 28 pairs.
    let respectSum = 0, respectCount = 0;
    let strongCount = 0;
    let agreeCount  = 0;
    let persistenceSum = 0;
    let deSum = 0;
    const pairs = [];
    for (const inst of PAIRS) {
      const { h1, m15 } = perPair[inst];
      if (!h1 || !m15) continue;
      const combined = (h1.respect + m15.respect) / 2;
      const combinedPersistence = (h1.persistence + m15.persistence) / 2;
      const combinedDe = (h1.de + m15.de) / 2;
      respectSum     += combined;
      persistenceSum += combinedPersistence;
      deSum          += combinedDe;
      respectCount++;
      if (combined > 80) strongCount++;
      const trendsAgree = h1.trend && m15.trend && h1.trend === m15.trend;
      if (trendsAgree) agreeCount++;
      pairs.push({
        pair: inst.replace('_', '/'),
        instrument: inst,
        h1Trend: h1.trend, h1Respect: h1.respect, h1Persistence: h1.persistence, h1De: h1.de,
        m15Trend: m15.trend, m15Respect: m15.respect, m15Persistence: m15.persistence, m15De: m15.de,
        combinedRespect: Math.round(combined),
        combinedPersistence: Math.round(combinedPersistence * 100),
        combinedDe: Math.round(combinedDe),
        trendsAgree,
      });
    }

    if (!respectCount) {
      return res.status(200).json({ error: 'No pairs had enough candles' });
    }

    const mti      = Math.round(respectSum / respectCount);
    const breadth  = Math.round((strongCount / respectCount) * 100);
    const agree    = Math.round((agreeCount / respectCount) * 100);
    const tpi      = Math.round((persistenceSum / respectCount) * 100);
    // MDE = Market Directional Efficiency — mean per-pair DE across the 28
    // pairs. Trending days ~40-70, choppy days ~10-25.
    const mde      = Math.round(deSum / respectCount);
    // New composite (weights sum to 1.00):
    //   0.25 MTI + 0.20 Breadth + 0.15 Agreement + 0.10 TPI + 0.30 MDE
    // MDE gets the biggest single weight because directional efficiency is
    // the true trend-vs-chop discriminator; the other four metrics were
    // failing to separate 9 Jul (trending) from 7 Jul (choppy) even though
    // the days had opposite character on the chart.
    const health   = Math.round(
      0.25 * mti +
      0.20 * breadth +
      0.15 * agree +
      0.10 * tpi +
      0.30 * mde
    );
    const classification = classify(health);

    // Sort pairs by combined respect desc so the strongest sit up top.
    pairs.sort((a, b) => b.combinedRespect - a.combinedRespect);

    res.json({
      generatedAt: anchorIso || new Date().toISOString(),
      duration_ms: Date.now() - t0,
      mti,
      breadth,
      agreement: agree,
      tpi,
      mde,
      health,
      classification,
      strongCount,
      agreeCount,
      totalPairs: respectCount,
      pairs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 30;
