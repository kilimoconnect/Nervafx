'use strict';

/**
 * GET /api/pullback-tri-h4-engine  — Triple-Timeframe Pullback Engine (H4/H1/M15)
 *
 * H4 = dominant trend (synthesized from H1), H1 = confirmation, M15 = trigger.
 * A pair takes a direction only when H4 and H1 EMA20/50 structures AGREE; M15
 * runs the pullback → realignment; the H4 candle drives the break gate and the
 * Activity/pressure reading. Only pairs whose last H4 candle broke the prior 5
 * H4 candles' high (buy) / low (sell) are returned.
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
const HOUR = 3600000, H4_MS = 4 * HOUR, M15_MS = 900000;
const STRONG_TH = 33, WEAK_TH = -33;
const FRESH = 4;   // M15 bars: a realignment this fresh (~1h) or fresher = ENTRY

function emaSeries(vals, period) {
  const k = 2 / (period + 1);
  const out = []; let e = null; const seed = [];
  for (let i = 0; i < vals.length; i++) {
    if (e === null) { seed.push(vals[i]); if (seed.length === period) e = seed.reduce((a, b) => a + b, 0) / period; out.push(e); }
    else { e = vals[i] * k + e * (1 - k); out.push(e); }
  }
  return out;
}

function h4OHLCSeries(h1, evalMs) {
  const m = new Map();
  for (const c of h1) {
    const bs = Math.floor(c.ms / H4_MS) * H4_MS;
    const b = m.get(bs);
    if (!b) m.set(bs, { start: bs, open: c.open, high: c.high, low: c.low, close: c.close });
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  const out = [];
  for (const b of [...m.values()].sort((a, x) => a.start - x.start)) {
    if (b.start <= evalMs - H4_MS) out.push({ open: b.open, high: b.high, low: b.low, close: b.close });
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

function atr14FromOHLC(c) {
  if (c.length < 2) return null;
  const trs = [];
  for (let i = 1; i < c.length; i++) trs.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  const last = trs.slice(-14);
  return last.length ? last.reduce((a, b) => a + b, 0) / last.length : null;
}

function pressureFrom(candles, dirSign) {
  const N = 14;
  if (!candles || candles.length < N + 1) return null;
  const atr = atr14FromOHLC(candles);
  if (!atr || atr <= 0) return null;
  const win = candles.slice(-N);
  const net = (win[N - 1].close - win[0].close) * dirSign;
  const dispATR = net / atr;
  let path = 0; for (let i = 1; i < N; i++) path += Math.abs(win[i].close - win[i - 1].close);
  const efficiency = path > 0 ? Math.abs(win[N - 1].close - win[0].close) / path : 0;
  let bodySum = 0, cnt = 0;
  for (const c of win) { const r = c.high - c.low; if (r > 0) { bodySum += Math.abs(c.close - c.open) / r; cnt++; } }
  const bodyDom = cnt ? bodySum / cnt : 0;
  const dispScore = Math.max(0, Math.min(1, dispATR / 6));
  const pressure = Math.round(100 * (0.5 * dispScore + 0.3 * efficiency + 0.2 * bodyDom));
  const half = Math.floor(N / 2);
  const recent = (win[N - 1].close - win[N - 1 - half].close) * dirSign / atr;
  const earlier = (win[N - 1 - half].close - win[0].close) * dirSign / atr;
  const decel = earlier > 1 && recent < earlier * 0.4;
  let activity;
  if (decel && pressure >= 35) activity = 'Exhausting';
  else if (pressure < 18) activity = 'Sleeping';
  else if (pressure < 38) activity = 'Building';
  else if (pressure < 60) activity = 'Expanding';
  else activity = 'Exploding';
  return { pressure, activity };
}

function brokeStructure(candles, dirSign) {
  if (!candles || candles.length < 6) return false;
  const n = candles.length, last = candles[n - 1];
  let hi = -Infinity, lo = Infinity;
  for (let i = n - 6; i < n - 1; i++) { if (candles[i].high > hi) hi = candles[i].high; if (candles[i].low < lo) lo = candles[i].low; }
  return dirSign > 0 ? last.high > hi : last.low < lo;
}

function summarize(pairs) {
  const active = pairs.filter(p => p.state !== 'NO_TREND');
  const order = ['Exploding', 'Expanding', 'Building', 'Exhausting', 'Sleeping'];
  let top = null; for (const a of order) if (active.some(p => p.activity === a)) { top = a; break; }
  return {
    active: active.length,
    trend: active.filter(p => p.state === 'BULL_TREND' || p.state === 'BEAR_TREND').length,
    transition: active.filter(p => p.state === 'TRANSITION').length,
    moving: active.filter(p => p.pressure >= 38).length,
    topActivity: top,
  };
}

async function fetchCloses(sb, inst, tf, limit, until) {
  let q = sb.from('backtest_candles').select('close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (until) q = q.lte('time', until);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(c => +c.close).reverse();
}
async function fetchH1(sb, inst, until) {
  let q = sb.from('backtest_candles').select('time, open, high, low, close')
    .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true);
  if (until) q = q.lte('time', until);
  const { data, error } = await q.order('time', { ascending: false }).limit(700);
  if (error) throw error;
  return (data || []).map(c => ({ ms: new Date(c.time).getTime(), open: +c.open, high: +c.high, low: +c.low, close: +c.close })).reverse();
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
    const untilH1 = new Date(evalMs - HOUR).toISOString();
    const untilM15 = new Date(evalMs - M15_MS).toISOString();
    const signalMs = Math.floor(evalMs / M15_MS) * M15_MS;

    const px = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const rows = await Promise.all(batch.map(async inst => {
        const [h1raw, m15c] = await Promise.all([fetchH1(sb, inst, untilH1), fetchCloses(sb, inst, 'M15', 220, untilM15)]);
        const h4ohlc = h4OHLCSeries(h1raw, evalMs);
        const h4 = snapOf(h4ohlc.map(c => c.close));       // dominant trend
        const h1 = snapOf(h1raw.map(c => c.close));        // confirmation
        const m15 = snapOf(m15c);                          // trigger
        let phase = 'NONE';
        if (h4 && h1 && m15) {
          const isBuy = h4.e20 > h4.e50, isBear = h4.e20 < h4.e50;
          if (isBuy || isBear) {
            const struct = [], aligned = [];
            for (let i = 0; i < m15.closes.length; i++) {
              const e2 = m15.s20[i], e5 = m15.s50[i];
              if (e2 == null || e5 == null) { struct.push(null); aligned.push(null); continue; }
              const c = m15.closes[i];
              struct.push(isBuy ? (e2 > e5) : (e2 < e5));
              aligned.push(isBuy ? (c > e2 && e2 > e5) : (c < e2 && e2 < e5));
            }
            phase = computePhase(struct, aligned);
          }
        }
        return { inst, h4, h1, m15, phase, h4ohlc: h4ohlc.slice(-40) };
      }));
      for (const r of rows) px[r.inst] = r;
    }

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
    const sH4 = strength('h4'), sH1 = strength('h1'), sM15 = strength('m15');
    const ranked = (s) => CCYS.map(c => ({ currency: c, strength: s[c], state: classify(s[c]) })).sort((a, b) => b.strength - a.strength);
    const qualityOf = (sc) => (sc >= 90 ? 'A+' : sc >= 80 ? 'High' : sc >= 70 ? 'Tradable' : 'Ignore');

    const pairs = [];
    for (const inst of PAIRS) {
      const P = px[inst];
      if (!P || !P.h4 || !P.h1 || !P.m15) continue;
      const [base, quote] = inst.split('_');
      const h4 = P.h4, h1 = P.h1, m15 = P.m15;
      const b4 = classify(sH4[base]), q4 = classify(sH4[quote]);
      const bM = classify(sM15[base]), qM = classify(sM15[quote]);

      // Trend state from the three timeframes' EMA20/50 direction.
      const tfd = (s) => { const g = Math.abs(s.e20 - s.e50) / s.e50; if (g < 0.0004) return 0; return s.e20 > s.e50 ? 1 : -1; };
      const dH4 = tfd(h4), dH1 = tfd(h1), dM15 = tfd(m15);
      const bulls = [dH4, dH1, dM15].filter(d => d > 0).length;
      const bears = [dH4, dH1, dM15].filter(d => d < 0).length;
      const flats = 3 - bulls - bears;
      let state;
      if (bulls === 3) state = 'BULL_TREND';
      else if (bears === 3) state = 'BEAR_TREND';
      else if (flats >= 2) state = 'NO_TREND';
      else state = 'TRANSITION';

      const h4Bull = h4.e20 > h4.e50, h4Bear = h4.e20 < h4.e50;
      const h1Bull = h1.e20 > h1.e50, h1Bear = h1.e20 < h1.e50;
      const domDir = dH4;                               // dominant timeframe = H4
      const dir = domDir > 0 ? 'BUY' : domDir < 0 ? 'SELL' : null;   // dominant-trend bias
      const pr = domDir !== 0 ? pressureFrom(P.h4ohlc, domDir) : null;
      const broke = domDir !== 0 ? brokeStructure(P.h4ohlc, domDir) : false;

      const isBuyBias = domDir > 0;
      const hCcyOk = domDir === 0 ? false : isBuyBias ? (b4 === 'STRONG' && q4 === 'WEAK') : (b4 === 'WEAK' && q4 === 'STRONG');
      const hCcyHalf = domDir === 0 ? false : isBuyBias ? (b4 === 'STRONG' || q4 === 'WEAK') : (b4 === 'WEAK' || q4 === 'STRONG');
      let score = 0;
      if (state === 'BULL_TREND' || state === 'BEAR_TREND') {
        const isBuy = state === 'BULL_TREND';
        const domFull = isBuy ? (h4.price > h4.e20 && h4.e20 > h4.e50) : (h4.price < h4.e20 && h4.e20 < h4.e50);
        score = 40 + (domFull ? 20 : 10) + (hCcyOk ? 30 : hCcyHalf ? 15 : 0) + (broke ? 10 : 0);
      } else if (state === 'TRANSITION') {
        score = 20 + (hCcyOk ? 10 : 0) + (broke ? 5 : 0);
      }

      pairs.push({
        pair: inst.replace('_', '/'), instrument: inst, direction: dir, broke,
        state, score, quality: qualityOf(score),
        pressure: pr ? pr.pressure : 0, activity: pr ? pr.activity : 'Sleeping',
        h4: {
          trend: h4Bull ? 'BULL' : h4Bear ? 'BEAR' : 'FLAT', bars: h4.bars,
          base: sH4[base], quote: sH4[quote], baseState: b4, quoteState: q4,
        },
        h1: {
          trend: h1Bull ? 'BULL' : h1Bear ? 'BEAR' : 'FLAT',
          base: sH1[base], quote: sH1[quote], baseState: classify(sH1[base]), quoteState: classify(sH1[quote]),
        },
        m15: {
          trend: (m15.e20 > m15.e50) ? 'BULL' : (m15.e20 < m15.e50) ? 'BEAR' : 'FLAT',
          base: sM15[base], quote: sM15[quote], baseState: bM, quoteState: qM,
        },
      });
    }

    const summary = summarize(pairs);
    const shown = pairs.filter(p => p.state !== 'NO_TREND').sort((a, b) => b.score - a.score);

    res.json({
      generatedAt: new Date(signalMs).toISOString(),
      thresholds: { strong: STRONG_TH, weak: WEAK_TH },
      currencies: { h4: ranked(sH4), h1: ranked(sH1), m15: ranked(sM15) },
      summary,
      pairs: shown,
    });
  } catch (e) {
    console.error('[pullback-tri-h4-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
