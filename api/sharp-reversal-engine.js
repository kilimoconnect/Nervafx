'use strict';

/**
 * GET /api/sharp-reversal-engine?mode=standard|swing
 *
 * Finds markets changing direction after a strong trend — the birth of a trend,
 * not established ones. Detected on the DOMINANT timeframe (impulse confirmed by
 * the trigger timeframe):
 *   standard: H1 (dominant) · M15 (confirm) · M5 (trigger)
 *   swing:    H4 (dominant, synth) · H1 (confirm) · M15 (trigger)
 *
 * Lifecycle states per pair:
 *   TREND → EXHAUSTION → REVERSAL_CANDIDATE → SHARP_REVERSAL → NEW_TREND
 * built from: prior trend (EMA20/50 stack age), exhaustion (fading pressure),
 * reversal impulse (ATR-normalised counter thrust), EMA20 recovery (price back
 * through EMA20), EMA20 slope change, EMA20/50 realignment (fresh cross), and
 * expansion of the new trend.
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
const HOUR = 3600000, H4_MS = 4 * HOUR, M15_MS = 900000, M5_MS = 300000;
const STRONG_TH = 33, WEAK_TH = -33;

const MODES = {
  standard: { dom: 'H1', mid: 'M15', trig: 'M5', synth: false, trigMs: M5_MS },
  swing:    { dom: 'H4', mid: 'H1', trig: 'M15', synth: true, trigMs: M15_MS },
};

function emaSeries(vals, period) {
  const k = 2 / (period + 1);
  const out = []; let e = null; const seed = [];
  for (let i = 0; i < vals.length; i++) {
    if (e === null) { seed.push(vals[i]); if (seed.length === period) e = seed.reduce((a, b) => a + b, 0) / period; out.push(e); }
    else { e = vals[i] * k + e * (1 - k); out.push(e); }
  }
  return out;
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
  const net = (win[N - 1].close - win[0].close) * dirSign, dispATR = net / atr;
  let path = 0; for (let i = 1; i < N; i++) path += Math.abs(win[i].close - win[i - 1].close);
  const efficiency = path > 0 ? Math.abs(win[N - 1].close - win[0].close) / path : 0;
  let bodySum = 0, cnt = 0;
  for (const c of win) { const r = c.high - c.low; if (r > 0) { bodySum += Math.abs(c.close - c.open) / r; cnt++; } }
  const bodyDom = cnt ? bodySum / cnt : 0;
  const pressure = Math.round(100 * (0.5 * Math.max(0, Math.min(1, dispATR / 6)) + 0.3 * efficiency + 0.2 * bodyDom));
  const half = Math.floor(N / 2);
  const recent = (win[N - 1].close - win[N - 1 - half].close) * dirSign / atr;
  const earlier = (win[N - 1 - half].close - win[0].close) * dirSign / atr;
  const decel = earlier > 1 && recent < earlier * 0.4;
  return { pressure, decel };
}
const classify = (s) => (s >= STRONG_TH ? 'STRONG' : s <= WEAK_TH ? 'WEAK' : 'NEUTRAL');

// Synthesize closed-H4 OHLC from ascending H1 {ms,open,high,low,close}.
function h4OHLC(h1, evalMs) {
  const m = new Map();
  for (const c of h1) {
    const bs = Math.floor(c.ms / H4_MS) * H4_MS, b = m.get(bs);
    if (!b) m.set(bs, { start: bs, open: c.open, high: c.high, low: c.low, close: c.close });
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  return [...m.values()].sort((a, b) => a.start - b.start).filter(b => b.start <= evalMs - H4_MS)
    .map(b => ({ open: b.open, high: b.high, low: b.low, close: b.close }));
}

async function fetchOHLC(sb, inst, tf, limit, until) {
  let q = sb.from('backtest_candles').select('time, open, high, low, close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (until) q = q.lte('time', until);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(c => ({ ms: new Date(c.time).getTime(), open: +c.open, high: +c.high, low: +c.low, close: +c.close })).reverse();
}
async function fetchCloses(sb, inst, tf, limit, until) {
  let q = sb.from('backtest_candles').select('close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (until) q = q.lte('time', until);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(c => +c.close).reverse();
}

// EMA snapshot on an OHLC/close series: last e20/e50/price, bars since cross,
// EMA20 slope sign, and (for OHLC) ATR + 3-bar impulse in ATR.
function snap(closes, ohlc) {
  if (closes.length < 55) return null;
  const s20 = emaSeries(closes, 20), s50 = emaSeries(closes, 50);
  const i = closes.length - 1, e20 = s20[i], e50 = s50[i], price = closes[i];
  if (e20 == null || e50 == null) return null;
  const sign = Math.sign(e20 - e50);
  let bars = 0;
  for (let j = i; j >= 0 && s20[j] != null && s50[j] != null && Math.sign(s20[j] - s50[j]) === sign; j--) bars++;
  const slope = s20[i - 4] != null ? Math.sign(e20 - s20[i - 4]) : 0;
  let atr = null, imp3 = 0;
  if (ohlc) { atr = atr14FromOHLC(ohlc); if (atr) imp3 = (price - closes[i - 3]) / atr; }
  return { e20, e50, price, stack: sign, bars, slope, priceVs20: Math.sign(price - e20), atr, imp3 };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    const mode = MODES[req.query?.mode] ? req.query.mode : 'standard';
    const M = MODES[mode];
    const now = Date.now();
    let evalMs = now;
    if (req.query?.at) { const t = new Date(req.query.at).getTime(); if (!isNaN(t)) evalMs = Math.min(t, now); }
    const untilFor = (tf) => new Date(evalMs - (tf === 'H4' ? H4_MS : tf === 'H1' ? HOUR : tf === 'M15' ? M15_MS : M5_MS)).toISOString();
    const signalMs = Math.floor(evalMs / M.trigMs) * M.trigMs;

    const px = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const rows = await Promise.all(batch.map(async inst => {
        let dom, mid, trig;
        if (M.synth) {
          const [h1ohlc, m15c] = await Promise.all([fetchOHLC(sb, inst, 'H1', 700, untilFor('H1')), fetchCloses(sb, inst, 'M15', 220, untilFor('M15'))]);
          const dohlc = h4OHLC(h1ohlc, evalMs);
          dom = snap(dohlc.map(c => c.close), dohlc.slice(-40));
          mid = snap(h1ohlc.map(c => c.close), null);
          trig = snap(m15c, null);
        } else {
          const [h1ohlc, m15c, m5c] = await Promise.all([
            fetchOHLC(sb, inst, 'H1', 220, untilFor('H1')),
            fetchCloses(sb, inst, 'M15', 220, untilFor('M15')),
            fetchCloses(sb, inst, 'M5', 300, untilFor('M5')),
          ]);
          dom = snap(h1ohlc.map(c => c.close), h1ohlc.slice(-40));
          mid = snap(m15c, null);
          trig = snap(m5c, null);
        }
        return { inst, dom, mid, trig };
      }));
      for (const r of rows) px[r.inst] = r;
    }

    // Dominant-timeframe currency strength (stack alignment / 7 → ×100).
    const acc = {}; CCYS.forEach(c => acc[c] = 0);
    for (const inst of PAIRS) {
      const d = px[inst] && px[inst].dom; if (!d) continue;
      const [base, quote] = inst.split('_');
      const a = d.priceVs20 === d.stack ? d.stack : d.stack * 0.5;   // full stack vs pinched
      acc[base] += a; acc[quote] -= a;
    }
    const sDom = {}; CCYS.forEach(c => { sDom[c] = Math.round((acc[c] / 7) * 100); });
    const ranked = CCYS.map(c => ({ currency: c, strength: sDom[c], state: classify(sDom[c]) })).sort((a, b) => b.strength - a.strength);

    const pairs = [];
    for (const inst of PAIRS) {
      const P = px[inst];
      if (!P || !P.dom || !P.mid || !P.trig) continue;
      const d = P.dom, S = d.stack, C = -S;

      // Reversal signals against the current dominant stack S.
      const recovered = d.priceVs20 === C;                       // EMA20 recovery
      const slopeTurn = d.slope === C;                           // EMA20 slope change
      const impulseC = Math.sign(d.imp3) === C && Math.abs(d.imp3) >= 1.0;   // reversal impulse
      const trigFlip = P.trig.stack === C;                       // trigger flipped
      const midFlip = P.mid.stack === C;                         // confirm flipped

      let state, dir;
      if (d.bars <= 6) { state = 'NEW_TREND'; dir = S; }         // fresh EMA20/50 cross = born trend
      else {
        const established = d.bars > 10;
        if (established && recovered && slopeTurn && (impulseC || (trigFlip && midFlip))) { state = 'SHARP_REVERSAL'; dir = C; }
        else if (established && (recovered || (slopeTurn && trigFlip))) { state = 'REVERSAL_CANDIDATE'; dir = C; }
        else if (isExhausted(d)) { state = 'EXHAUSTION'; dir = S; }
        else { state = 'TREND'; dir = S; }
      }

      const base = { SHARP_REVERSAL: 80, NEW_TREND: 70, REVERSAL_CANDIDATE: 55, EXHAUSTION: 42, TREND: 22 }[state];
      const score = Math.min(100, base + Math.min(20, Math.round(Math.abs(d.imp3) * 8)));

      pairs.push({
        pair: inst.replace('_', '/'), instrument: inst,
        direction: dir > 0 ? 'BUY' : 'SELL', state, score,
        dom: { stack: S > 0 ? 'BULL' : 'BEAR', bars: d.bars, slope: d.slope > 0 ? 'UP' : d.slope < 0 ? 'DOWN' : 'FLAT', priceVs20: d.priceVs20 > 0 ? 'above' : 'below', impulseATR: +d.imp3.toFixed(2) },
        mid: { stack: P.mid.stack > 0 ? 'BULL' : P.mid.stack < 0 ? 'BEAR' : 'FLAT' },
        trig: { stack: P.trig.stack > 0 ? 'BULL' : P.trig.stack < 0 ? 'BEAR' : 'FLAT' },
      });
    }
    const order = { SHARP_REVERSAL: 0, NEW_TREND: 1, REVERSAL_CANDIDATE: 2, EXHAUSTION: 3, TREND: 4 };
    pairs.sort((a, b) => order[a.state] - order[b.state] || b.score - a.score);

    res.json({
      generatedAt: new Date(signalMs).toISOString(),
      mode, timeframes: { dominant: M.dom, confirm: M.mid, trigger: M.trig },
      currencies: ranked,
      pairs,
    });
  } catch (e) {
    console.error('[sharp-reversal-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

// Exhaustion: established trend whose recent impulse has stalled/reversed and
// price has pulled back to the EMA20 without a full reversal yet.
function isExhausted(d) {
  if (d.bars <= 10) return false;
  const S = d.stack;
  const pulledBack = d.priceVs20 !== S;          // price no longer beyond EMA20 in trend dir
  const impFading = Math.sign(d.imp3) !== S || Math.abs(d.imp3) < 0.3;
  return pulledBack && impFading;
}

module.exports.maxDuration = 60;
