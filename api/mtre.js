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

// Per-pair Trend Respect on a series of candles:
//   trend = 'BUY' (EMA20 > EMA50 at current close) or 'SELL' (EMA20 < EMA50).
// Score is the mean over the last 10 candles of:
//   0.40 * (close on correct side of EMA20 ? 1 : 0)
//   0.30 * (EMA20 on correct side of EMA50 ? 1 : 0)
//   0.30 * (EMA20 slope in trend direction ? 1 : 0)
// Returned in [0, 100].
function pairRespect(closes) {
  if (!closes || closes.length < 60) return null;
  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const last = closes.length - 1;
  const curE20 = e20[last], curE50 = e50[last];
  if (curE20 == null || curE50 == null) return null;
  const trend = curE20 > curE50 ? 'BUY' : curE20 < curE50 ? 'SELL' : null;
  if (!trend) return { trend: null, respect: 0 };

  const sig = trend === 'BUY' ? +1 : -1;
  const N = 10;
  let total = 0;
  for (let i = 0; i < N; i++) {
    const idx = last - i;
    if (idx < 20) break;
    const c = closes[idx];
    const a20 = e20[idx];
    const a50 = e50[idx];
    const a20prev = idx >= 5 ? e20[idx - 5] : null;
    if (a20 == null || a50 == null || a20prev == null) continue;
    const sideOk  = Math.sign(c - a20)   === sig ? 1 : 0;
    const stackOk = Math.sign(a20 - a50) === sig ? 1 : 0;
    const slopeOk = Math.sign(a20 - a20prev) === sig ? 1 : 0;
    total += 0.40 * sideOk + 0.30 * stackOk + 0.30 * slopeOk;
  }
  return { trend, respect: Math.round((total / N) * 100) };
}

function classify(health) {
  if (health >= 85) return 'TRENDING';
  if (health >= 70) return 'GOOD_TREND';
  if (health >= 50) return 'MIXED';
  return 'REVERSAL_CHOPPY';
}

async function fetchCloses(sb, inst, tf, limit, untilIso) {
  let q = sb
    .from('backtest_candles')
    .select('time, close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (untilIso) q = q.lte('time', untilIso);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).reverse().map(c => parseFloat(c.close));
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
        const [h1Closes, m15Closes] = await Promise.all([
          fetchCloses(sb, inst, 'H1',  80, anchorIso),
          fetchCloses(sb, inst, 'M15', 80, anchorIso),
        ]);
        perPair[inst] = {
          h1:  pairRespect(h1Closes),
          m15: pairRespect(m15Closes),
        };
      }));
    }

    // MTI (average of h1+m15 respect scores across the 28 pairs).
    let respectSum = 0, respectCount = 0;
    let strongCount = 0;
    let agreeCount  = 0;
    const pairs = [];
    for (const inst of PAIRS) {
      const { h1, m15 } = perPair[inst];
      if (!h1 || !m15) continue;
      const combined = (h1.respect + m15.respect) / 2;
      respectSum   += combined;
      respectCount++;
      if (combined > 80) strongCount++;
      const trendsAgree = h1.trend && m15.trend && h1.trend === m15.trend;
      if (trendsAgree) agreeCount++;
      pairs.push({
        pair: inst.replace('_', '/'),
        instrument: inst,
        h1Trend: h1.trend, h1Respect: h1.respect,
        m15Trend: m15.trend, m15Respect: m15.respect,
        combinedRespect: Math.round(combined),
        trendsAgree,
      });
    }

    if (!respectCount) {
      return res.status(200).json({
        error: 'No pairs had enough candles',
      });
    }

    const mti      = Math.round(respectSum / respectCount);
    const breadth  = Math.round((strongCount / respectCount) * 100);
    const agree    = Math.round((agreeCount / respectCount) * 100);
    const health   = Math.round(0.40 * mti + 0.35 * breadth + 0.25 * agree);
    const classification = classify(health);

    // Sort pairs by combined respect desc so the strongest sit up top.
    pairs.sort((a, b) => b.combinedRespect - a.combinedRespect);

    res.json({
      generatedAt: anchorIso || new Date().toISOString(),
      duration_ms: Date.now() - t0,
      mti,
      breadth,
      agreement: agree,
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
