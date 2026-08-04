'use strict';

/**
 * GET /api/pullback-tri-engine  — Triple-Timeframe Pullback Engine (H1/M15/M5)
 *
 * H1 = dominant trend, M15 = confirmation, M5 = trigger. A pair only takes a
 * direction when H1 and M15 EMA20/50 structures AGREE; the M5 timeframe runs
 * the pullback → realignment sequence; the H1 candle drives the break gate and
 * the Activity/pressure reading.
 *
 * State: NO_TREND → WAIT → PULLBACK → ENTRY, TREND for an already-running
 * aligned trend, REVERSAL_RISK when M5 currency strength flips against the H1
 * trend. Only pairs whose last H1 candle broke the prior 5 H1 candles' high
 * (buy) / low (sell) are returned. 0–100 signal score.
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
const HOUR = 3600000, M15_MS = 900000, M5_MS = 300000;
const STRONG_TH = 33, WEAK_TH = -33;
const FRESH = 6;   // M5 bars: a realignment this fresh (~30 min) or fresher = ENTRY

function emaSeries(vals, period) {
  const k = 2 / (period + 1);
  const out = []; let e = null; const seed = [];
  for (let i = 0; i < vals.length; i++) {
    if (e === null) { seed.push(vals[i]); if (seed.length === period) e = seed.reduce((a, b) => a + b, 0) / period; out.push(e); }
    else { e = vals[i] * k + e * (1 - k); out.push(e); }
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
  return { pressure, activity, dispATR: +dispATR.toFixed(2), efficiency: +efficiency.toFixed(2), bodyDom: +bodyDom.toFixed(2) };
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
async function fetchOHLC(sb, inst, tf, limit, until) {
  let q = sb.from('backtest_candles').select('open, high, low, close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (until) q = q.lte('time', until);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(c => ({ open: +c.open, high: +c.high, low: +c.low, close: +c.close })).reverse();
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
    const untilM5 = new Date(evalMs - M5_MS).toISOString();
    const signalMs = Math.floor(evalMs / M5_MS) * M5_MS;

    const px = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const rows = await Promise.all(batch.map(async inst => {
        const [h1ohlc, m15c, m5c] = await Promise.all([
          fetchOHLC(sb, inst, 'H1', 220, untilH1),
          fetchCloses(sb, inst, 'M15', 220, untilM15),
          fetchCloses(sb, inst, 'M5', 400, untilM5),
        ]);
        const h1 = snapOf(h1ohlc.map(c => c.close));   // dominant trend
        const m15 = snapOf(m15c);                       // confirmation
        const m5 = snapOf(m5c);                         // trigger
        // M5 phase evaluated in the (agreed) H1 direction.
        let phase = 'NONE';
        if (h1 && m15 && m5) {
          const isBuy = h1.e20 > h1.e50, isBear = h1.e20 < h1.e50;
          if (isBuy || isBear) {
            const struct = [], aligned = [];
            for (let i = 0; i < m5.closes.length; i++) {
              const e2 = m5.s20[i], e5 = m5.s50[i];
              if (e2 == null || e5 == null) { struct.push(null); aligned.push(null); continue; }
              const c = m5.closes[i];
              struct.push(isBuy ? (e2 > e5) : (e2 < e5));
              aligned.push(isBuy ? (c > e2 && e2 > e5) : (c < e2 && e2 < e5));
            }
            phase = computePhase(struct, aligned);
          }
        }
        return { inst, h1, m15, m5, phase, h1ohlc: h1ohlc.slice(-40) };
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
    const sH1 = strength('h1'), sM15 = strength('m15'), sM5 = strength('m5');
    const ranked = (s) => CCYS.map(c => ({ currency: c, strength: s[c], state: classify(s[c]) })).sort((a, b) => b.strength - a.strength);
    const qualityOf = (sc) => (sc >= 90 ? 'A+' : sc >= 80 ? 'High' : sc >= 70 ? 'Tradable' : 'Ignore');

    const pairs = [];
    for (const inst of PAIRS) {
      const P = px[inst];
      if (!P || !P.h1 || !P.m15 || !P.m5) continue;
      const [base, quote] = inst.split('_');
      const h1 = P.h1, m15 = P.m15, m5 = P.m5;
      const b1 = classify(sH1[base]), q1 = classify(sH1[quote]);
      const b5 = classify(sM5[base]), q5 = classify(sM5[quote]);

      // Trend state from the three timeframes' EMA20/50 direction.
      const tfd = (s) => { const g = Math.abs(s.e20 - s.e50) / s.e50; if (g < 0.0004) return 0; return s.e20 > s.e50 ? 1 : -1; };
      const dH1 = tfd(h1), dM15 = tfd(m15), dM5 = tfd(m5);
      const bulls = [dH1, dM15, dM5].filter(d => d > 0).length;
      const bears = [dH1, dM15, dM5].filter(d => d < 0).length;
      const flats = 3 - bulls - bears;
      let state;
      if (bulls === 3) state = 'BULL_TREND';
      else if (bears === 3) state = 'BEAR_TREND';
      else if (flats >= 2) state = 'NO_TREND';
      else state = 'TRANSITION';

      const h1Bull = h1.e20 > h1.e50, h1Bear = h1.e20 < h1.e50;
      const m15Bull = m15.e20 > m15.e50, m15Bear = m15.e20 < m15.e50;
      const domDir = dH1;                               // dominant timeframe = H1
      const dir = state === 'BULL_TREND' ? 'BUY' : state === 'BEAR_TREND' ? 'SELL' : null;
      const pr = domDir !== 0 ? pressureFrom(P.h1ohlc, domDir) : null;
      const broke = domDir !== 0 ? brokeStructure(P.h1ohlc, domDir) : false;

      const isBuyBias = domDir > 0;
      const hCcyOk = domDir === 0 ? false : isBuyBias ? (b1 === 'STRONG' && q1 === 'WEAK') : (b1 === 'WEAK' && q1 === 'STRONG');
      const hCcyHalf = domDir === 0 ? false : isBuyBias ? (b1 === 'STRONG' || q1 === 'WEAK') : (b1 === 'WEAK' || q1 === 'STRONG');
      let score = 0;
      if (state === 'BULL_TREND' || state === 'BEAR_TREND') {
        const isBuy = state === 'BULL_TREND';
        const domFull = isBuy ? (h1.price > h1.e20 && h1.e20 > h1.e50) : (h1.price < h1.e20 && h1.e20 < h1.e50);
        score = 40 + (domFull ? 20 : 10) + (hCcyOk ? 30 : hCcyHalf ? 15 : 0) + (broke ? 10 : 0);
      } else if (state === 'TRANSITION') {
        score = 20 + (hCcyOk ? 10 : 0) + (broke ? 5 : 0);
      }

      pairs.push({
        pair: inst.replace('_', '/'), instrument: inst, direction: dir, broke,
        state, score, quality: qualityOf(score),
        pressure: pr ? pr.pressure : 0, activity: pr ? pr.activity : 'Sleeping',
        h1: {
          trend: h1Bull ? 'BULL' : h1Bear ? 'BEAR' : 'FLAT', bars: h1.bars,
          base: sH1[base], quote: sH1[quote], baseState: b1, quoteState: q1,
        },
        m15: {
          trend: m15Bull ? 'BULL' : m15Bear ? 'BEAR' : 'FLAT',
          base: sM15[base], quote: sM15[quote], baseState: classify(sM15[base]), quoteState: classify(sM15[quote]),
        },
        m5: {
          trend: (m5.e20 > m5.e50) ? 'BULL' : (m5.e20 < m5.e50) ? 'BEAR' : 'FLAT',
          base: sM5[base], quote: sM5[quote], baseState: b5, quoteState: q5,
        },
      });
    }

    const summary = summarize(pairs);
    const shown = pairs.filter(p => p.state !== 'NO_TREND').sort((a, b) => b.score - a.score);

    res.json({
      generatedAt: new Date(signalMs).toISOString(),
      thresholds: { strong: STRONG_TH, weak: WEAK_TH },
      currencies: { h1: ranked(sH1), m15: ranked(sM15), m5: ranked(sM5) },
      summary,
      pairs: shown,
    });
  } catch (e) {
    console.error('[pullback-tri-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
