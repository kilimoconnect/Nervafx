'use strict';

/**
 * GET /api/mtre[?anchor=ISO]
 *
 * Market Trend Respect Engine — movement-based redesign.
 *
 * Per pair per TF (H1 + M15):
 *   direction: EMA20 > EMA50 → BUY, EMA20 < EMA50 → SELL, else null (skip).
 *
 *   Walk the last 20 candles vs each candle's immediately-preceding bar.
 *   For each candle contribute the raw price movement of the structural
 *   break (in the pair's native price units):
 *
 *     BUY  trendMove   += max(0, high[i] - high[i-1])   (higher-high break)
 *          counterMove += max(0, low[i-1] - low[i])     (lower-low break)
 *     SELL trendMove   += max(0, low[i-1] - low[i])
 *          counterMove += max(0, high[i] - high[i-1])
 *
 *   respect = trendMove / (trendMove + counterMove) × 100
 *
 * The ratio is self-normalising, so pips vs price units doesn't matter and
 * the metric is directly comparable across pairs (no ATR normalisation
 * needed). A pair posting 160 pips of higher-high breaks and 40 pips of
 * lower-low breaks scores 80.
 *
 * Market rollup (per TF):
 *   BUY MTRE  = mean respect of pairs with direction == 'BUY'
 *   SELL MTRE = mean respect of pairs with direction == 'SELL'
 *   Dominant  = whichever of BUY/SELL is higher; drives the state badge.
 *
 * Per pair alignment = (H1.respect + M15.respect) / 2 when H1.dir ==
 * M15.dir, else 0 — divergent pairs pull market alignment down.
 *
 * States (based on max of H1 BUY / SELL MTRE):
 *   ≥ 80  STRONG_TRENDING
 *   ≥ 65  HEALTHY_TREND
 *   ≥ 50  DEVELOPING
 *   ≥ 35  WEAK_TREND
 *   < 35  CHAOTIC
 *
 * Currency layer: winning currency gets +respect, losing gets −respect,
 * averaged across the 7 pairs, mapped to 0..100.
 */

const { cors, getClient } = require('./_db');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];
const CCYS = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD'];

const LOOKBACK = 20; // candles used for the structural-break sum

function pipDiv(inst) { return inst.includes('JPY') ? 0.01 : 0.0001; }

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function pairRespect(candles, inst) {
  if (!candles || candles.length < 51 + 1) return null; // EMA50 + 1 lookback bar
  const closes = candles.map(c => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  if (e20 == null || e50 == null) return null;
  const direction = e20 > e50 ? 'BUY' : e20 < e50 ? 'SELL' : null;
  if (!direction) return { direction: null, respect: 0, trendMove: 0, counterMove: 0 };

  const N = Math.min(LOOKBACK, candles.length - 1);
  const start = candles.length - N;
  let trendMove = 0, counterMove = 0;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!p) continue;
    const highBreak = Math.max(0, c.high - p.high);
    const lowBreak  = Math.max(0, p.low  - c.low);
    if (direction === 'BUY') { trendMove += highBreak; counterMove += lowBreak; }
    else                     { trendMove += lowBreak;  counterMove += highBreak; }
  }
  const total   = trendMove + counterMove;
  const respect = total > 0 ? Math.round((trendMove / total) * 100) : 0;
  const pd = pipDiv(inst);
  return {
    direction,
    respect,
    trendPips:   Math.round((trendMove   / pd) * 10) / 10,
    counterPips: Math.round((counterMove / pd) * 10) / 10,
  };
}

function classify(dominantMtre) {
  if (dominantMtre >= 80) return 'STRONG_TRENDING';
  if (dominantMtre >= 65) return 'HEALTHY_TREND';
  if (dominantMtre >= 50) return 'DEVELOPING';
  if (dominantMtre >= 35) return 'WEAK_TREND';
  return 'CHAOTIC';
}

async function fetchOHLC(sb, inst, tf, limit, untilIso) {
  let q = sb.from('backtest_candles')
    .select('time, open, high, low, close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (untilIso) q = q.lte('time', untilIso);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).reverse().map(c => ({
    open:  parseFloat(c.open),  high:  parseFloat(c.high),
    low:   parseFloat(c.low),   close: parseFloat(c.close),
  }));
}

function currencyStrength(pairsByInst, tfKey) {
  const raw = {}; CCYS.forEach(c => raw[c] = 0);
  const cnt = {}; CCYS.forEach(c => cnt[c] = 0);
  for (const inst of PAIRS) {
    const r = pairsByInst[inst][tfKey];
    if (!r || r.direction == null) continue;
    const [base, quote] = inst.split('_');
    if (r.direction === 'BUY') { raw[base] += r.respect; raw[quote] -= r.respect; }
    else                       { raw[base] -= r.respect; raw[quote] += r.respect; }
    cnt[base]++;
    cnt[quote]++;
  }
  const out = {};
  for (const c of CCYS) {
    const signed = cnt[c] ? raw[c] / cnt[c] : 0;
    out[c] = Math.round((signed + 100) / 2);
  }
  return out;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const anchorIso = req.query?.anchor ? new Date(req.query.anchor).toISOString() : null;

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
          h1:  pairRespect(h1Candles,  inst),
          m15: pairRespect(m15Candles, inst),
        };
      }));
    }

    // Roll up per side per TF.
    let h1BuySum = 0, h1BuyN = 0, h1SellSum = 0, h1SellN = 0;
    let m15BuySum = 0, m15BuyN = 0, m15SellSum = 0, m15SellN = 0;
    let alignSum = 0, count = 0;
    const pairs = [];
    for (const inst of PAIRS) {
      const { h1, m15 } = perPair[inst];
      if (!h1 || !m15) continue;
      count++;
      if (h1.direction === 'BUY')  { h1BuySum  += h1.respect;  h1BuyN++;  }
      if (h1.direction === 'SELL') { h1SellSum += h1.respect;  h1SellN++; }
      if (m15.direction === 'BUY') { m15BuySum += m15.respect; m15BuyN++; }
      if (m15.direction === 'SELL'){ m15SellSum += m15.respect; m15SellN++; }
      const dirsMatch = h1.direction && m15.direction && h1.direction === m15.direction;
      const alignment = dirsMatch ? (h1.respect + m15.respect) / 2 : 0;
      alignSum += alignment;
      pairs.push({
        pair: inst.replace('_', '/'), instrument: inst,
        h1Direction: h1.direction, h1Respect: h1.respect, h1TrendPips: h1.trendPips, h1CounterPips: h1.counterPips,
        m15Direction: m15.direction, m15Respect: m15.respect, m15TrendPips: m15.trendPips, m15CounterPips: m15.counterPips,
        alignment: Math.round(alignment), dirsMatch,
      });
    }
    if (!count) return res.status(200).json({ error: 'No pairs had enough candles' });

    const h1Buy   = h1BuyN  ? Math.round(h1BuySum  / h1BuyN)  : 0;
    const h1Sell  = h1SellN ? Math.round(h1SellSum / h1SellN) : 0;
    const m15Buy  = m15BuyN ? Math.round(m15BuySum / m15BuyN) : 0;
    const m15Sell = m15SellN? Math.round(m15SellSum/ m15SellN): 0;
    const align   = Math.round(alignSum / count);

    // State: based on H1 dominant side (which is stronger, BUY or SELL).
    const h1Dominant = Math.max(h1Buy, h1Sell);
    const dominantSide = h1Buy >= h1Sell ? 'BUY' : 'SELL';
    const state = classify(h1Dominant);

    pairs.sort((a, b) => b.alignment - a.alignment || b.h1Respect - a.h1Respect);

    const currencies = { h1: currencyStrength(perPair, 'h1'), m15: currencyStrength(perPair, 'm15') };

    res.json({
      generatedAt: anchorIso || new Date().toISOString(),
      duration_ms: Date.now() - t0,
      h1BuyMtre:  h1Buy,  h1SellMtre:  h1Sell,  h1BuyCount:  h1BuyN,  h1SellCount:  h1SellN,
      m15BuyMtre: m15Buy, m15SellMtre: m15Sell, m15BuyCount: m15BuyN, m15SellCount: m15SellN,
      alignment: align,
      dominantSide, state,
      totalPairs: count,
      currencies, pairs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 30;
