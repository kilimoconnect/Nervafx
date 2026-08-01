'use strict';

/**
 * GET /api/pullback-h4-engine  — Pullback-Continuation Engine (H4 / H1)
 *
 * Mirror of /api/pullback-engine but one timeframe up: H4 defines the trend
 * (direction + integrity + currency strength) and H1 is the trigger (pullback
 * detection + realignment entry). H4 is synthesized from stored H1 candles.
 *
 * State per pair: NO_TREND → WAIT → PULLBACK → ENTRY, with TREND for an
 * already-running aligned trend and REVERSAL_RISK when H1 currency strength
 * flips against the H4 trend. 0–100 signal score.
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
const HOUR = 3600000, H4_MS = 4 * HOUR;
const STRONG_TH = 33, WEAK_TH = -33;
const FRESH = 3;   // H1 bars: a realignment this fresh (or fresher) = ENTRY

function emaSeries(vals, period) {
  const k = 2 / (period + 1);
  const out = []; let e = null; const seed = [];
  for (let i = 0; i < vals.length; i++) {
    if (e === null) { seed.push(vals[i]); if (seed.length === period) e = seed.reduce((a, b) => a + b, 0) / period; out.push(e); }
    else { e = vals[i] * k + e * (1 - k); out.push(e); }
  }
  return out;
}

// Synthesize the closed-H4 close series from ascending H1 {ms, close}. A 4h
// bucket is used only once it has fully closed (bucketStart + 4h <= evalMs).
function h4CloseSeries(h1, evalMs) {
  const m = new Map();
  for (const c of h1) m.set(Math.floor(c.ms / H4_MS) * H4_MS, c.close);   // ascending → last close wins
  const out = [];
  for (const [start, close] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
    if (start <= evalMs - H4_MS) out.push(close);
  }
  return out;
}

function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50) return 1;
  if (close < e20 && e20 < e50) return -1;
  if (close > e20 && e20 <= e50) return 0.5;
  if (close < e20 && e20 >= e50) return -0.5;
  return 0;
}
const classify = (s) => (s >= STRONG_TH ? 'STRONG' : s <= WEAK_TH ? 'WEAK' : 'NEUTRAL');

// Walk the trigger alignment sequence to enforce TREND → PULLBACK → ENTRY.
function computePhase(struct, aligned) {
  let last = struct.length - 1;
  while (last >= 0 && struct[last] == null) last--;
  if (last < 0) return 'NONE';
  if (struct[last] === false) return 'TRIGGER_REVERSED';
  if (aligned[last] === false) return 'PULLBACK';
  let alignRun = 0, i = last;
  for (; i >= 0 && struct[i] === true && aligned[i] === true; i--) alignRun++;
  let pbRun = 0, k = i;
  for (; k >= 0 && struct[k] === true && aligned[k] === false; k--) pbRun++;
  const priorAligned = (k >= 0 && struct[k] === true && aligned[k] === true);
  if (pbRun > 0 && priorAligned) return alignRun <= FRESH ? 'ENTRY' : 'TREND';
  return 'TREND';
}

function snapOf(closes) {
  if (closes.length < 51) return null;
  const s20 = emaSeries(closes, 20), s50 = emaSeries(closes, 50);
  const i = closes.length - 1, e20 = s20[i], e50 = s50[i], price = closes[i];
  if (e20 == null || e50 == null) return null;
  const sign = Math.sign(e20 - e50);
  let bars = 0;
  for (let j = i; j >= 0 && s20[j] != null && s50[j] != null && Math.sign(s20[j] - s50[j]) === sign; j--) bars++;
  return { price, e20, e50, bars, align: alignmentScore(price, e20, e50), s20, s50, closes };
}

async function fetchH1(sb, inst, until) {
  let q = sb.from('backtest_candles')
    .select('time, close')
    .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true);
  if (until) q = q.lte('time', until);
  const { data, error } = await q.order('time', { ascending: false }).limit(700);
  if (error) throw error;
  return (data || []).map(c => ({ ms: new Date(c.time).getTime(), close: +c.close })).reverse();   // ascending
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    const now = Date.now();
    let evalMs = now;
    if (req.query?.at) { const t = new Date(req.query.at).getTime(); if (!isNaN(t)) evalMs = Math.min(t, now); }
    // Signal (close) time: only H1 candles closed by evalMs; H1 closes at open+1h.
    const untilH1 = new Date(evalMs - HOUR).toISOString();
    const signalMs = Math.floor(evalMs / HOUR) * HOUR;

    const px = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const rows = await Promise.all(batch.map(async inst => {
        const h1raw = await fetchH1(sb, inst, untilH1);
        const h1Closes = h1raw.map(c => c.close);
        const h4Closes = h4CloseSeries(h1raw, evalMs);
        const h4 = snapOf(h4Closes);      // trend
        const h1 = snapOf(h1Closes);      // trigger
        // H1 phase evaluated in the H4 trend direction.
        let phase = 'NONE';
        if (h4 && h1) {
          const isBuy = h4.e20 > h4.e50, isBear = h4.e20 < h4.e50;
          if (isBuy || isBear) {
            const struct = [], aligned = [];
            for (let i = 0; i < h1.closes.length; i++) {
              const e2 = h1.s20[i], e5 = h1.s50[i];
              if (e2 == null || e5 == null) { struct.push(null); aligned.push(null); continue; }
              const c = h1.closes[i];
              struct.push(isBuy ? (e2 > e5) : (e2 < e5));
              aligned.push(isBuy ? (c > e2 && e2 > e5) : (c < e2 && e2 < e5));
            }
            phase = computePhase(struct, aligned);
          }
        }
        return { inst, h4, h1, phase };
      }));
      for (const r of rows) px[r.inst] = r;
    }

    // Currency strength (H4 + H1): base + / quote - alignment, /7 → ×100.
    const strength = (tf) => {
      const acc = {}; CCYS.forEach(c => acc[c] = 0);
      for (const inst of PAIRS) {
        const s = px[inst] && px[inst][tf];
        if (!s) continue;
        const [base, quote] = inst.split('_');
        acc[base] += s.align; acc[quote] -= s.align;
      }
      const out = {}; CCYS.forEach(c => { out[c] = Math.round((acc[c] / 7) * 100); });
      return out;
    };
    const sH4 = strength('h4'), sH1 = strength('h1');
    const ranked = (s) => CCYS.map(c => ({ currency: c, strength: s[c], state: classify(s[c]) })).sort((a, b) => b.strength - a.strength);
    const qualityOf = (sc) => (sc >= 90 ? 'A+' : sc >= 80 ? 'High' : sc >= 70 ? 'Tradable' : 'Ignore');

    const pairs = [];
    for (const inst of PAIRS) {
      const P = px[inst];
      if (!P || !P.h4 || !P.h1) continue;
      const [base, quote] = inst.split('_');
      const h4 = P.h4, h1 = P.h1;
      const b4 = classify(sH4[base]), q4 = classify(sH4[quote]);
      const b1 = classify(sH1[base]), q1 = classify(sH1[quote]);

      const bull = h4.e20 > h4.e50, bear = h4.e20 < h4.e50;
      const dir = bull ? 'BUY' : bear ? 'SELL' : null;
      const phase = P.phase;

      let state, score = 0;
      if (!dir) {
        state = 'NO_TREND';
      } else {
        const isBuy = dir === 'BUY';
        const h4FullPrice = isBuy ? (h4.price > h4.e20 && h4.e20 > h4.e50) : (h4.price < h4.e20 && h4.e20 < h4.e50);
        const h4CcyOk = isBuy ? (b4 === 'STRONG' && q4 === 'WEAK') : (b4 === 'WEAK' && q4 === 'STRONG');
        const h4CcyHalf = isBuy ? (b4 === 'STRONG' || q4 === 'WEAK') : (b4 === 'WEAK' || q4 === 'STRONG');
        const h1CcyMatch = isBuy ? (b1 === 'STRONG' && q1 === 'WEAK') : (b1 === 'WEAK' && q1 === 'STRONG');
        const h1Flipped = isBuy ? (b1 === 'WEAK' || q1 === 'STRONG') : (b1 === 'STRONG' || q1 === 'WEAK');

        score += h4FullPrice ? 30 : 15;
        score += h4CcyOk ? 25 : h4CcyHalf ? 13 : 0;
        score += 15;
        score += h1Flipped ? 0 : 15;
        score += phase === 'ENTRY' ? 15 : phase === 'TREND' ? 10 : 0;

        if (h1Flipped || phase === 'TRIGGER_REVERSED') state = 'REVERSAL_RISK';
        else if (phase === 'ENTRY' && h4CcyOk && h1CcyMatch) state = 'ENTRY';
        else if (phase === 'PULLBACK') state = 'PULLBACK';
        else if (phase === 'TREND') state = h4CcyOk ? 'TREND' : 'WAIT';
        else state = 'WAIT';
      }

      pairs.push({
        pair: inst.replace('_', '/'), instrument: inst, direction: dir, phase,
        state, score, quality: qualityOf(score),
        h4: {
          trend: bull ? 'BULL' : bear ? 'BEAR' : 'FLAT', bars: h4.bars,
          price: +h4.price.toFixed(6), e20: +h4.e20.toFixed(6), e50: +h4.e50.toFixed(6),
          base: sH4[base], quote: sH4[quote], baseState: b4, quoteState: q4,
        },
        h1: {
          trend: (h1.e20 > h1.e50) ? 'BULL' : (h1.e20 < h1.e50) ? 'BEAR' : 'FLAT',
          price: +h1.price.toFixed(6), e20: +h1.e20.toFixed(6), e50: +h1.e50.toFixed(6),
          base: sH1[base], quote: sH1[quote], baseState: b1, quoteState: q1,
        },
      });
    }
    pairs.sort((a, b) => b.score - a.score);

    res.json({
      generatedAt: new Date(signalMs).toISOString(),
      thresholds: { strong: STRONG_TH, weak: WEAK_TH },
      currencies: { h4: ranked(sH4), h1: ranked(sH1) },
      pairs,
    });
  } catch (e) {
    console.error('[pullback-h4-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
