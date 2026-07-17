'use strict';

/**
 * GET /api/mtre[?anchor=ISO]
 *
 * Market Trend Respect Engine (v3).
 *
 * Direction (per pair per TF):
 *   spread = |EMA20 - EMA50| / ATR14
 *   if spread < 0.10  → NEUTRAL (respect = 0)
 *   elif EMA20 > EMA50 → BUY
 *   else               → SELL
 *
 * Four Respect components (each 0-1):
 *   A. EMA Quality = min(1, spread / 0.5)   — 0.5 ATR = perfect separation
 *   B. Price/EMA20 = 1 if close on correct side of EMA20, else 0
 *   C. Price/EMA50 = 1 if close on correct side of EMA50, else 0
 *   D. Structure   = (HH count + HL count) / 20 for BUY   (over last 10 bars)
 *                    (LH count + LL count) / 20 for SELL
 *
 *   Respect = (0.30 A + 0.25 B + 0.20 C + 0.25 D) × 100
 *
 * Per pair alignment = (H1.respect + M15.respect) / 2 when H1.dir == M15.dir,
 * else 0 — divergent pairs pull the market alignment down.
 *
 * Market rollup:
 *   H1AvgRespect  = mean H1.respect across 28 pairs
 *   M15AvgRespect = mean M15.respect across 28 pairs
 *   Alignment     = mean of per-pair alignment values
 *   Breadth       = # pairs with H1.respect ≥ 70, out of the 28, × 100
 *   StrongBuy     = # H1.direction == BUY  AND respect ≥ 70
 *   StrongSell    = # H1.direction == SELL AND respect ≥ 70
 *
 *   MTRE = 0.35 H1Avg + 0.35 M15Avg + 0.20 Alignment + 0.10 Breadth
 *
 * States: CHAOTIC (<30) · WEAK_TREND (30-50) · DEVELOPING (50-70) ·
 *         HEALTHY_TREND (70-85) · STRONG_TRENDING (≥85).
 *
 * Currency layer: for each pair credit the winning currency +respect and
 * debit the losing one −respect, then average per currency across its 7
 * pairs and map −100..+100 → 0..100.
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

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atr(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Structure v3: HH + HL over the last 10 bars, divided by 20 (max possible).
//   Inside candles no longer punish the score outright — a bar that fails HH
//   but still respects HL contributes 0.5.
//   BUY: HH = high[i] > high[i-1]; HL = low[i] > low[i-1]
//   SELL: LH = high[i] < high[i-1]; LL = low[i] < low[i-1]
function structureScore(candles, direction) {
  const N = 10;
  if (candles.length < N + 1) return 0;
  const win = candles.slice(-N - 1); // 11 candles → 10 comparisons
  let hits = 0;
  for (let i = 1; i < win.length; i++) {
    if (direction === 'BUY') {
      if (win[i].high > win[i - 1].high) hits++;
      if (win[i].low  > win[i - 1].low)  hits++;
    } else {
      if (win[i].high < win[i - 1].high) hits++;
      if (win[i].low  < win[i - 1].low)  hits++;
    }
  }
  return hits / (N * 2); // 0.0 - 1.0
}

const SPREAD_NEUTRAL_THRESHOLD = 0.10;   // spread < 0.10 ATR → NEUTRAL
const SPREAD_QUALITY_SATURATION = 0.50;  // spread ≥ 0.50 ATR → Quality = 1.0

function pairRespect(candles) {
  if (!candles || candles.length < 51) return null;
  const closes = candles.map(c => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const a14 = atr(candles, 14);
  if (e20 == null || e50 == null || !a14) return null;
  const cur = closes[closes.length - 1];

  const spread = Math.abs(e20 - e50) / a14;
  if (spread < SPREAD_NEUTRAL_THRESHOLD) {
    return { direction: null, respect: 0, structure: 0, spread: +spread.toFixed(2), quality: 0 };
  }

  let direction, priceE20, priceE50;
  if (e20 > e50) {
    direction = 'BUY';
    priceE20 = cur > e20 ? 1 : 0;
    priceE50 = cur > e50 ? 1 : 0;
  } else {
    direction = 'SELL';
    priceE20 = cur < e20 ? 1 : 0;
    priceE50 = cur < e50 ? 1 : 0;
  }

  const quality   = Math.min(1, spread / SPREAD_QUALITY_SATURATION);   // 0-1
  const structure = structureScore(candles, direction);                // 0-1

  const respect = Math.round((0.30 * quality + 0.25 * priceE20 + 0.20 * priceE50 + 0.25 * structure) * 100);
  return {
    direction,
    respect,
    structure:  Math.round(structure * 20),   // shown as N/20 in UI
    spread:     +spread.toFixed(2),
    quality:    +quality.toFixed(2),
    priceEma20: priceE20,
    priceEma50: priceE50,
  };
}

function classify(mtre) {
  if (mtre >= 85) return 'STRONG_TRENDING';
  if (mtre >= 70) return 'HEALTHY_TREND';
  if (mtre >= 50) return 'DEVELOPING';
  if (mtre >= 30) return 'WEAK_TREND';
  return 'CHAOTIC';
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

// Currency signed rollup on a given TF. Winning side gets +respect; losing
// side gets −respect. Divided by contributing count (usually 7).
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
    const signed = cnt[c] ? raw[c] / cnt[c] : 0;   // −100..+100
    out[c] = Math.round((signed + 100) / 2);       // 0..100
  }
  return out;
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
          fetchOHLC(sb, inst, 'H1',  60, anchorIso),
          fetchOHLC(sb, inst, 'M15', 60, anchorIso),
        ]);
        perPair[inst] = {
          h1:  pairRespect(h1Candles),
          m15: pairRespect(m15Candles),
        };
      }));
    }

    // Roll up.
    let h1Sum = 0, m15Sum = 0, alignSum = 0, count = 0;
    let strongBuy = 0, strongSell = 0, strongPairs = 0;
    const pairs = [];
    for (const inst of PAIRS) {
      const { h1, m15 } = perPair[inst];
      if (!h1 || !m15) continue;
      count++;
      h1Sum  += h1.respect;
      m15Sum += m15.respect;
      const dirsMatch = h1.direction && m15.direction && h1.direction === m15.direction;
      const alignment = dirsMatch ? (h1.respect + m15.respect) / 2 : 0;
      alignSum += alignment;
      if (h1.respect >= 70) strongPairs++;
      if (h1.direction === 'BUY'  && h1.respect >= 70) strongBuy++;
      if (h1.direction === 'SELL' && h1.respect >= 70) strongSell++;
      pairs.push({
        pair: inst.replace('_', '/'),
        instrument: inst,
        h1Direction:  h1.direction,  h1Respect:  h1.respect,  h1Structure:  h1.structure,  h1Quality:  h1.quality,  h1Spread:  h1.spread,
        m15Direction: m15.direction, m15Respect: m15.respect, m15Structure: m15.structure, m15Quality: m15.quality, m15Spread: m15.spread,
        alignment: Math.round(alignment),
        dirsMatch,
      });
    }

    if (!count) return res.status(200).json({ error: 'No pairs had enough candles' });

    const h1Avg      = Math.round(h1Sum / count);
    const m15Avg     = Math.round(m15Sum / count);
    const alignAvg   = Math.round(alignSum / count);
    const breadth    = Math.round((strongPairs / count) * 100);
    const mtre       = Math.round(0.35 * h1Avg + 0.35 * m15Avg + 0.20 * alignAvg + 0.10 * breadth);
    const state      = classify(mtre);

    // Sort pairs strongest-aligned first, then by H1 respect.
    pairs.sort((a, b) => {
      if (b.alignment !== a.alignment) return b.alignment - a.alignment;
      return b.h1Respect - a.h1Respect;
    });

    const currencies = {
      h1:  currencyStrength(perPair, 'h1'),
      m15: currencyStrength(perPair, 'm15'),
    };

    res.json({
      generatedAt: anchorIso || new Date().toISOString(),
      duration_ms: Date.now() - t0,
      h1AvgRespect:  h1Avg,
      m15AvgRespect: m15Avg,
      alignment:     alignAvg,
      breadth,
      strongBuy,
      strongSell,
      strongPairs,
      totalPairs:    count,
      mtre,
      state,
      currencies,
      pairs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 30;
