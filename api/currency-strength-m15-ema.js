'use strict';

/**
 * GET /api/currency-strength-m15-ema
 *
 * Per-currency strength derived from M15 EMA20 / EMA50 / close on all 28
 * pairs. Same alignment maths as /api/currency-strength-h1-ema; only the
 * candle timeframe changes. The M15 series updates every 15 min while the
 * pipeline cron polls every 5, so this page effectively reacts as fast as
 * the underlying candles allow.
 *
 * Per pair — signed alignment score in [-1, +1]:
 *   close > EMA20 > EMA50   →  +1.0
 *   close > EMA20, e20<=e50 →  +0.5
 *   close < EMA20 < EMA50   →  -1.0
 *   close < EMA20, e20>=e50 →  -0.5
 *   otherwise               →   0
 *
 * Each pair credits +score to its base currency and -score to its quote.
 * Divide by 7 → per-currency strength in [-1, +1].
 */

const { cors, getClient } = require('./_db');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];
const CCYS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

async function fetchLastM15(sb, inst, limit = 80) {
  const { data, error } = await sb
    .from('backtest_candles')
    .select('time, close')
    .eq('instrument', inst).eq('timeframe', 'M15').eq('complete', true)
    .order('time', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse().map(c => ({ time: c.time, close: parseFloat(c.close) }));
}

function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50)   return +1.0;
  if (close < e20 && e20 < e50)   return -1.0;
  if (close > e20 && e20 <= e50)  return +0.5;
  if (close < e20 && e20 >= e50)  return -0.5;
  return 0;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const t0 = Date.now();
  const sb = getClient();

  try {
    const pairResults = [];
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const rows = await Promise.all(batch.map(async inst => {
        const candles = await fetchLastM15(sb, inst, 80);
        if (candles.length < 51) {
          return { pair: inst, score: 0, close: null, e20: null, e50: null, dist_pct: 0, error: 'insufficient' };
        }
        const closes = candles.map(c => c.close);
        const e20 = ema(closes, 20);
        const e50 = ema(closes, 50);
        const c   = closes[closes.length - 1];
        const s   = alignmentScore(c, e20, e50);
        const dist = e20 ? ((c - e20) / e20) * 100 : 0;
        return {
          pair: inst,
          time: candles[candles.length - 1].time,
          close: c, e20, e50,
          score: s,
          dist_pct: dist,
        };
      }));
      pairResults.push(...rows);
    }

    const agg = {}; const distAgg = {};
    CCYS.forEach(k => { agg[k] = 0; distAgg[k] = 0; });
    for (const r of pairResults) {
      if (r.error) continue;
      const [base, quote] = r.pair.split('_');
      agg[base]  += r.score;
      agg[quote] -= r.score;
      distAgg[base]  += r.dist_pct;
      distAgg[quote] -= r.dist_pct;
    }

    const currencies = CCYS.map(cur => ({
      currency: cur,
      strength: agg[cur] / 7,
      raw_sum: agg[cur],
      dist_pct: distAgg[cur] / 7,
    })).sort((a, b) => b.strength - a.strength);

    res.json({
      generatedAt: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      currencies,
      pairs: pairResults,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 30;
