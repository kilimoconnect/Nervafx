'use strict';

/**
 * GET /api/pullback-engine  — Pullback-Continuation Engine
 *
 * Separates DIRECTION (H1) from EXECUTION (M15) across 28 pairs.
 *
 *  H1 layer   — trend from EMA20/EMA50 structure (survives pullbacks), trend
 *               integrity (EMA20 must stay the right side of EMA50), and an
 *               EMA-based currency-strength ranking (-100..+100).
 *  M15 layer  — same EMAs used to spot the pullback (price loses EMA alignment
 *               / currency rotates to NEUTRAL) and the realignment (price +
 *               EMA + currency snap back into the H1 direction).
 *
 * State per pair: NO_TREND → WAIT → PULLBACK → ENTRY, with REVERSAL_RISK when
 * M15 currency strength flips against the H1 trend (strong→weak / weak→strong).
 * A 0–100 signal score prioritises the cleanest setups.
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
const STRONG_TH = 33, WEAK_TH = -33;   // classify normalised strength (-100..+100)

// EMA over an ascending close series → array (null until it seeds).
function emaSeries(vals, period) {
  const k = 2 / (period + 1);
  const out = []; let e = null; const seed = [];
  for (let i = 0; i < vals.length; i++) {
    if (e === null) { seed.push(vals[i]); if (seed.length === period) e = seed.reduce((a, b) => a + b, 0) / period; out.push(e); }
    else { e = vals[i] * k + e * (1 - k); out.push(e); }
  }
  return out;
}

// Currency-strength alignment score for one pair (±1 clean stack, ±0.5 partial).
function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50) return 1;
  if (close < e20 && e20 < e50) return -1;
  if (close > e20 && e20 <= e50) return 0.5;
  if (close < e20 && e20 >= e50) return -0.5;
  return 0;
}
const classify = (s) => (s >= STRONG_TH ? 'STRONG' : s <= WEAK_TH ? 'WEAK' : 'NEUTRAL');

async function fetchCloses(sb, inst, tf, limit) {
  const { data, error } = await sb
    .from('backtest_candles')
    .select('close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true)
    .order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(c => +c.close).reverse();   // ascending
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    // Per-pair H1 + M15 EMA snapshot.
    const px = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const rows = await Promise.all(batch.map(async inst => {
        const [h1, m15] = await Promise.all([fetchCloses(sb, inst, 'H1', 220), fetchCloses(sb, inst, 'M15', 220)]);
        const snap = (closes) => {
          if (closes.length < 51) return null;
          const s20 = emaSeries(closes, 20), s50 = emaSeries(closes, 50);
          const i = closes.length - 1;
          const e20 = s20[i], e50 = s50[i], price = closes[i];
          if (e20 == null || e50 == null) return null;
          // bars since EMA20/EMA50 last crossed (trend age / integrity).
          const sign = Math.sign(e20 - e50);
          let bars = 0;
          for (let j = i; j >= 0 && s20[j] != null && s50[j] != null && Math.sign(s20[j] - s50[j]) === sign; j--) bars++;
          return { price, e20, e50, bars, align: alignmentScore(price, e20, e50) };
        };
        return { inst, h1: snap(h1), m15: snap(m15) };
      }));
      for (const r of rows) px[r.inst] = r;
    }

    // Currency strength (H1 + M15): sum of per-pair alignment (base +, quote -),
    // /7 → [-1,1] → ×100.
    const strength = (tf) => {
      const acc = {}; CCYS.forEach(c => acc[c] = 0);
      for (const inst of PAIRS) {
        const s = px[inst] && px[inst][tf];
        if (!s) continue;
        const [base, quote] = inst.split('_');
        acc[base] += s.align; acc[quote] -= s.align;
      }
      const out = {};
      CCYS.forEach(c => { out[c] = Math.round((acc[c] / 7) * 100); });
      return out;
    };
    const sH1 = strength('h1'), sM15 = strength('m15');
    const ranked = (s) => CCYS.map(c => ({ currency: c, strength: s[c], state: classify(s[c]) })).sort((a, b) => b.strength - a.strength);

    const qualityOf = (sc) => (sc >= 90 ? 'A+' : sc >= 80 ? 'High' : sc >= 70 ? 'Tradable' : 'Ignore');

    const pairs = [];
    for (const inst of PAIRS) {
      const P = px[inst];
      if (!P || !P.h1 || !P.m15) continue;
      const [base, quote] = inst.split('_');
      const h1 = P.h1, m15 = P.m15;
      const bH1 = classify(sH1[base]), qH1 = classify(sH1[quote]);
      const bM15 = classify(sM15[base]), qM15 = classify(sM15[quote]);

      const h1Bull = h1.e20 > h1.e50, h1Bear = h1.e20 < h1.e50;
      const dir = h1Bull ? 'BUY' : h1Bear ? 'SELL' : null;

      let state, score = 0;
      if (!dir) {
        state = 'NO_TREND';
      } else {
        const isBuy = dir === 'BUY';
        const h1FullPrice = isBuy ? (h1.price > h1.e20 && h1.e20 > h1.e50) : (h1.price < h1.e20 && h1.e20 < h1.e50);
        const h1CcyOk = isBuy ? (bH1 === 'STRONG' && qH1 === 'WEAK') : (bH1 === 'WEAK' && qH1 === 'STRONG');
        const h1CcyHalf = isBuy ? (bH1 === 'STRONG' || qH1 === 'WEAK') : (bH1 === 'WEAK' || qH1 === 'STRONG');
        const m15Full = isBuy ? (m15.price > m15.e20 && m15.e20 > m15.e50) : (m15.price < m15.e20 && m15.e20 < m15.e50);
        const m15CcyMatch = isBuy ? (bM15 === 'STRONG' && qM15 === 'WEAK') : (bM15 === 'WEAK' && qM15 === 'STRONG');
        const m15Flipped = isBuy ? (bM15 === 'WEAK' || qM15 === 'STRONG') : (bM15 === 'STRONG' || qM15 === 'WEAK');

        // Score (weights: 30 / 25 / 15 / 15 / 15).
        score += h1FullPrice ? 30 : 15;                          // H1 EMA structure
        score += h1CcyOk ? 25 : h1CcyHalf ? 13 : 0;              // H1 strength separation
        score += 15;                                             // H1 integrity (in-trend)
        score += m15Flipped ? 0 : 15;                            // M15 pullback quality
        score += (m15Full && m15CcyMatch) ? 15 : 0;             // M15 realignment

        if (m15Flipped) state = 'REVERSAL_RISK';
        else if (m15Full && m15CcyMatch && h1CcyOk) state = 'ENTRY';
        else if (!m15Full) state = 'PULLBACK';
        else state = 'WAIT';
      }

      pairs.push({
        pair: inst.replace('_', '/'), instrument: inst, direction: dir,
        state, score, quality: qualityOf(score),
        h1: {
          trend: h1Bull ? 'BULL' : h1Bear ? 'BEAR' : 'FLAT', bars: h1.bars,
          price: +h1.price.toFixed(6), e20: +h1.e20.toFixed(6), e50: +h1.e50.toFixed(6),
          base: sH1[base], quote: sH1[quote], baseState: bH1, quoteState: qH1,
        },
        m15: {
          trend: (m15.e20 > m15.e50) ? 'BULL' : (m15.e20 < m15.e50) ? 'BEAR' : 'FLAT',
          price: +m15.price.toFixed(6), e20: +m15.e20.toFixed(6), e50: +m15.e50.toFixed(6),
          base: sM15[base], quote: sM15[quote], baseState: bM15, quoteState: qM15,
        },
      });
    }
    pairs.sort((a, b) => b.score - a.score);

    res.json({
      generatedAt: new Date().toISOString(),
      thresholds: { strong: STRONG_TH, weak: WEAK_TH },
      currencies: { h1: ranked(sH1), m15: ranked(sM15) },
      pairs,
    });
  } catch (e) {
    console.error('[pullback-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
