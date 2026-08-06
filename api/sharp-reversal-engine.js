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
const HOUR = 3600000, H4_MS = 4 * HOUR, M30_MS = 1800000, M15_MS = 900000, M5_MS = 300000;
const STRONG_TH = 33, WEAK_TH = -33;

const MODES = {
  standard: { dom: 'H1',  mid: 'M15', trig: 'M5', synth: false, trigMs: M5_MS },
  swing:    { dom: 'M30', mid: 'M15', trig: 'M5', synth: true,  trigMs: M5_MS },   // M30 synthesized from M15
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

// Synthesize a closed OHLC series by bucketing ascending {ms,o,h,l,c} candles
// into `size`-ms buckets (used for M30 from M15).
function synthOHLC(src, size, evalMs) {
  const m = new Map();
  for (const c of src) {
    const bs = Math.floor(c.ms / size) * size, b = m.get(bs);
    if (!b) m.set(bs, { start: bs, open: c.open, high: c.high, low: c.low, close: c.close });
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  return [...m.values()].sort((a, b) => a.start - b.start).filter(b => b.start <= evalMs - size)
    .map(b => ({ open: b.open, high: b.high, low: b.low, close: b.close }));
}

// Break of structure: last closed candle closed beyond the highest high (buy) /
// lowest low (sell) of the previous 5 candles.
function brokeStructure(ohlc, dirSign) {
  if (!ohlc || ohlc.length < 6) return false;
  const n = ohlc.length, last = ohlc[n - 1];
  let hi = -Infinity, lo = Infinity;
  for (let i = n - 6; i < n - 1; i++) { if (ohlc[i].high > hi) hi = ohlc[i].high; if (ohlc[i].low < lo) lo = ohlc[i].low; }
  return dirSign > 0 ? last.close > hi : last.close < lo;
}

// How far the last close broke beyond the prior-5 high/low, in ATR (negative if
// it didn't break).
function breakDistATR(ohlc, dirSign, atr) {
  if (!ohlc || ohlc.length < 6 || !atr) return 0;
  const n = ohlc.length, last = ohlc[n - 1];
  let hi = -Infinity, lo = Infinity;
  for (let i = n - 6; i < n - 1; i++) { if (ohlc[i].high > hi) hi = ohlc[i].high; if (ohlc[i].low < lo) lo = ohlc[i].low; }
  return (dirSign > 0 ? (last.close - hi) : (lo - last.close)) / atr;
}

// Reversal Energy (0-100): conviction behind the move, independent of state.
//   35% impulse · 25% break strength · 20% EMA20 expansion · 20% acceleration.
function reversalEnergy(d, domOHLC, dir) {
  const atr = d.atr || 1;
  const impulse = Math.min(100, Math.abs(d.imp3) * 50);                        // ~2 ATR = 100
  const brk = Math.max(0, Math.min(1, breakDistATR(domOHLC, dir, atr) / 0.6)) * 100;  // 0.6 ATR past = 100
  const expansion = Math.max(0, Math.min(1, ((d.price - d.e20) * dir) / atr)) * 100;  // 1 ATR from EMA20 = 100
  const cur = d.imp3 * dir, prev = d.imp3prev * dir;                           // impulse in the move's direction
  const accel = cur <= 0 ? 0 : Math.max(0, Math.min(100, 50 + (cur - prev) * 50)); // growing >50, fading <50
  const energy = Math.round(0.35 * impulse + 0.25 * brk + 0.20 * expansion + 0.20 * accel);
  const label = energy >= 90 ? 'Explosive' : energy >= 75 ? 'Strong' : energy >= 60 ? 'Healthy' : energy >= 40 ? 'Weak' : 'Fading';
  return { energy, label, parts: { impulse: Math.round(impulse), break: Math.round(brk), expansion: Math.round(expansion), accel: Math.round(accel) } };
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
  let atr = null, imp3 = 0, imp3prev = 0;
  if (ohlc) { atr = atr14FromOHLC(ohlc); if (atr) { imp3 = (price - closes[i - 3]) / atr; if (i - 6 >= 0) imp3prev = (closes[i - 3] - closes[i - 6]) / atr; } }
  return { e20, e50, price, stack: sign, bars, slope, priceVs20: Math.sign(price - e20), atr, imp3, imp3prev };
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
    const tfMs = { H4: H4_MS, M30: M30_MS, H1: HOUR, M15: M15_MS, M5: M5_MS };
    const untilFor = (tf) => new Date(evalMs - (tfMs[tf] || M5_MS)).toISOString();
    const signalMs = Math.floor(evalMs / M.trigMs) * M.trigMs;

    const px = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const rows = await Promise.all(batch.map(async inst => {
        let dom, mid, trig, domOHLC;
        if (M.synth) {
          const [m15ohlc, m5c] = await Promise.all([fetchOHLC(sb, inst, 'M15', 500, untilFor('M15')), fetchCloses(sb, inst, 'M5', 300, untilFor('M5'))]);
          const dohlc = synthOHLC(m15ohlc, M30_MS, evalMs);   // M30 from M15
          domOHLC = dohlc.slice(-10);
          dom = snap(dohlc.map(c => c.close), dohlc.slice(-40));
          mid = snap(m15ohlc.map(c => c.close), null);
          trig = snap(m5c, null);
        } else {
          const [h1ohlc, m15c, m5c] = await Promise.all([
            fetchOHLC(sb, inst, 'H1', 220, untilFor('H1')),
            fetchCloses(sb, inst, 'M15', 220, untilFor('M15')),
            fetchCloses(sb, inst, 'M5', 300, untilFor('M5')),
          ]);
          domOHLC = h1ohlc.slice(-10);
          dom = snap(h1ohlc.map(c => c.close), h1ohlc.slice(-40));
          mid = snap(m15c, null);
          trig = snap(m5c, null);
        }
        return { inst, dom, mid, trig, domOHLC };
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
      const d = P.dom;
      const crossBars = P.mid.bars;      // bars since the confirm-TF (M15) EMA20/50 cross
      const S = P.mid.stack;             // confirm-TF direction = the new trend direction
      if (!S) continue;                  // flat confirm → no direction
      const dir = S;
      const en = reversalEnergy(d, P.domOHLC, dir);   // conviction layer (drives the energy gate below)

      // Reversal states need the dominant EMA20 still the WRONG side of EMA50
      // (buy: EMA20<EMA50, sell: EMA20>EMA50). SHARP_REVERSAL fires on a fresh
      // M15 cross (<=15 candles) OR — cross not mandatory — when Energy >= 70.
      let state;
      if (d.stack === -dir && (crossBars <= 15 || en.energy >= 70)) state = 'SHARP_REVERSAL';
      else if (d.bars <= 5 && d.stack === dir) state = 'NEW_TREND';   // dominant just crossed to align (last 5 candles)
      else state = (isExhausted(d) && d.stack === dir) ? 'EXHAUSTION' : 'TREND';

      const broke = brokeStructure(P.domOHLC, dir);   // last dominant candle broke prior-5 high/low in dir
      // Ranking score = 40% state type + 35% energy + 25% ATR impulse.
      const stateW = { SHARP_REVERSAL: 100, NEW_TREND: 78, EXHAUSTION: 50, TREND: 35 }[state];
      const impScore = Math.min(100, Math.abs(d.imp3) * 40);   // ~2.5 ATR = 100
      const score = Math.round(0.4 * stateW + 0.35 * en.energy + 0.25 * impScore);

      pairs.push({
        pair: inst.replace('_', '/'), instrument: inst,
        direction: dir > 0 ? 'BUY' : 'SELL', state, score, broke,
        energy: en.energy, energyLabel: en.label, energyParts: en.parts,
        dom: { stack: d.stack > 0 ? 'BULL' : d.stack < 0 ? 'BEAR' : 'FLAT', bars: d.bars, slope: d.slope > 0 ? 'UP' : d.slope < 0 ? 'DOWN' : 'FLAT', priceVs20: d.priceVs20 > 0 ? 'above' : 'below', impulseATR: +d.imp3.toFixed(2) },
        mid: { stack: P.mid.stack > 0 ? 'BULL' : P.mid.stack < 0 ? 'BEAR' : 'FLAT', bars: crossBars },
        trig: { stack: P.trig.stack > 0 ? 'BULL' : P.trig.stack < 0 ? 'BEAR' : 'FLAT' },
      });
    }
    const order = { SHARP_REVERSAL: 0, NEW_TREND: 1, REVERSAL_CANDIDATE: 2, EXHAUSTION: 3, TREND: 4 };
    // Break-of-structure gate + drop reversal candidates (not confirmed enough).
    const shown = pairs.filter(p => p.broke && p.state !== 'REVERSAL_CANDIDATE' && p.energy >= 70)
      .sort((a, b) => order[a.state] - order[b.state] || b.score - a.score);   // drop energy < 70

    res.json({
      generatedAt: new Date(signalMs).toISOString(),
      mode, timeframes: { dominant: M.dom, confirm: M.mid, trigger: M.trig },
      currencies: ranked,
      pairs: shown,
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
