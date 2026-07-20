'use strict';

/**
 * GET /api/currency-strength-m5-ema-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Per-currency M5 EMA strength across the requested window, one snapshot
 * every 5 minutes. Same maths as /api/currency-strength-h1-ema-history —
 * pre-fetches every pair's M5 candles once (with a warmup buffer for
 * EMA50), streams through them with rolling EMAs, and snapshots at every
 * 5-min anchor.
 *
 *   {
 *     from, to, snapshots, duration_sec,
 *     rows: [{ time, currencies: { USD: -0.71, EUR: +0.14, ... } }]
 *   }
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
const STEP = 5 * 60 * 1000;

function makeEma(period) {
  const k = 2 / (period + 1);
  let seedBuf = [];
  let e = null;
  return function push(v) {
    if (e === null) {
      seedBuf.push(v);
      if (seedBuf.length === period) e = seedBuf.reduce((a, b) => a + b, 0) / period;
      return e;
    }
    e = v * k + e * (1 - k);
    return e;
  };
}

async function fetchAllM5(sb, inst, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', inst).eq('timeframe', 'M5').eq('complete', true)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({
      ms:    new Date(c.time).getTime(),
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
    })));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

function pipDiv(inst) { return inst.includes('JPY') ? 0.01 : 0.0001; }

// ─── Lower-timeframe swing confirmation ─────────────────────────────────────
// A signal is only trusted if the confirmation timeframe has already printed
// a SECOND consecutive higher swing high (BUY) or second consecutive lower
// swing low (SELL) — i.e. structure has actually turned, not just poked once.
//
//   H1 signal  → confirm on M15
//   M15 signal → confirm on M5
//   M5 signal  → confirm on M5 (its own structure)  ← this file
const LTF = 'M5';
const SWING_K = 1;        // fractal width: 1 candle each side
const SWING_WINDOW = 60;  // LTF candles inspected per anchor
const SWINGS_NEEDED = 2;  // "second" higher-high / lower-low

function detectSwings(candles, k) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(candles[i].high > candles[i - j].high && candles[i].high > candles[i + j].high)) isHigh = false;
      if (!(candles[i].low  < candles[i - j].low  && candles[i].low  < candles[i + j].low))  isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow)  lows.push(candles[i].low);
  }
  return { highs, lows };
}

function swingConfirm(ltfCandles, direction, k, need) {
  if (!ltfCandles || ltfCandles.length < 5) return { ok: false, count: 0 };
  const { highs, lows } = detectSwings(ltfCandles, k);
  const seq = direction === 'BUY' ? highs : lows;
  if (seq.length < need + 1) return { ok: false, count: 0 };
  let count = 0;
  for (let i = seq.length - 1; i > 0; i--) {
    const better = direction === 'BUY' ? seq[i] > seq[i - 1] : seq[i] < seq[i - 1];
    if (!better) break;
    count++;
  }
  return { ok: count >= need, count };
}

function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50)  return +1.0;
  if (close < e20 && e20 < e50)  return -1.0;
  if (close > e20 && e20 <= e50) return +0.5;
  if (close < e20 && e20 >= e50) return -0.5;
  return 0;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const from = req.query?.from;
  const to   = req.query?.to;
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });

  const start = new Date(from + 'T00:00:00Z');
  let end     = new Date(to   + 'T23:55:00Z');
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'invalid dates' });
  // Don't scan future anchors.
  const nowLast = Math.floor(Date.now() / STEP) * STEP - STEP;
  if (end.getTime() > nowLast) end = new Date(nowLast);

  const t0 = Date.now();
  const sb = getClient();

  // 2-day warmup buffer covers EMA50 on M15 comfortably.
  const fetchSince = new Date(start.getTime() - 2 * 24 * 3600000).toISOString();
  const fetchUntil = new Date(end.getTime()   + 60 * 60000).toISOString();

  const candles = {};
  const errors  = [];
  for (let b = 0; b < PAIRS.length; b += 7) {
    const batch = PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try { candles[inst] = await fetchAllM5(sb, inst, fetchSince, fetchUntil); }
      catch (e) { errors.push(`${inst}: ${e.message}`); candles[inst] = []; }
    }));
  }

  const targetAnchors = [];
  for (let t = start.getTime(); t <= end.getTime(); t += STEP) targetAnchors.push(t);
  const targetSet = new Set(targetAnchors);

  // Break on last 6 M5 candles + trend-alignment window on last 20. Same
  // above/below counts emitted on the break entry as the other TFs.
  // Impulse metrics accompany every break so the frontend can judge HOW
  // STRONG the move is, not just how many pips it covered. Raw pips aren't
  // comparable across pairs, so we normalise by a rolling ATR14:
  //   bodyAtr    = |close-open| / ATR14   → body vs the pair's typical range
  //   efficiency = |close-open| / (high-low) → how decisive (body vs wicks)
  //   impulse    = bodyAtr × efficiency × 100 → single comparable score
  //   breakAtr   = distance past the broken level, in ATRs
  const BREAK_LOOKBACK = 6;
  const TREND_LOOKBACK = 20;
  const ATR_PERIOD = 14;
  const pairScores = {};
  const pairBreaks = {};
  for (const inst of PAIRS) {
    const seq = candles[inst] || [];
    if (!seq.length) { pairScores[inst] = new Map(); pairBreaks[inst] = new Map(); continue; }
    const pushE20 = makeEma(20);
    const pushE50 = makeEma(50);
    const scoreMap = new Map();
    const breakMap = new Map();
    const pd = pipDiv(inst);
    const prevWin = [];
    const stateWin = [];
    const trWin = [];    // rolling true-range window for ATR14
    let prevClose = null;
    for (const c of seq) {
      // Rolling true range — the first bar has no previous close to compare.
      const tr = prevClose == null
        ? (c.high - c.low)
        : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      trWin.push(tr);
      if (trWin.length > ATR_PERIOD) trWin.shift();
      const atr = trWin.length === ATR_PERIOD
        ? trWin.reduce((a, b) => a + b, 0) / ATR_PERIOD
        : null;

      const e20 = pushE20(c.close);
      const e50 = pushE50(c.close);
      if (e20 != null && e50 != null) {
        let state = 'between';
        if (c.close > e20 && c.close > e50) state = 'above';
        else if (c.close < e20 && c.close < e50) state = 'below';
        stateWin.push(state);
        if (stateWin.length > TREND_LOOKBACK) stateWin.shift();
      }
      if (e20 != null && e50 != null && targetSet.has(c.ms)) {
        scoreMap.set(c.ms, alignmentScore(c.close, e20, e50));
        if (prevWin.length >= BREAK_LOOKBACK && atr) {
          let maxH = -Infinity, minL = Infinity;
          for (const p of prevWin) { if (p.high > maxH) maxH = p.high; if (p.low < minL) minL = p.low; }
          const body  = Math.abs(c.close - c.open);
          const range = c.high - c.low;
          const bodyPips   = Math.round((body / pd) * 10) / 10;
          const atrPips    = Math.round((atr  / pd) * 10) / 10;
          const bodyAtr    = Math.round((body / atr) * 100) / 100;
          const efficiency = range > 0 ? Math.round((body / range) * 100) / 100 : 0;
          const impulse    = Math.round(bodyAtr * efficiency * 100);
          let above = 0, below = 0;
          for (const s of stateWin) { if (s === 'above') above++; else if (s === 'below') below++; }
          if (c.close > maxH) {
            const breakAtr = Math.round(((c.close - maxH) / atr) * 100) / 100;
            breakMap.set(c.ms, { direction: 'BUY',  bodyPips, atrPips, bodyAtr, efficiency, impulse, breakAtr, above, below });
          } else if (c.close < minL) {
            const breakAtr = Math.round(((minL - c.close) / atr) * 100) / 100;
            breakMap.set(c.ms, { direction: 'SELL', bodyPips, atrPips, bodyAtr, efficiency, impulse, breakAtr, above, below });
          }
        }
      }
      prevWin.push(c);
      if (prevWin.length > BREAK_LOOKBACK) prevWin.shift();
      prevClose = c.close;
    }
    pairScores[inst] = scoreMap;
    pairBreaks[inst] = breakMap;
  }

  const rows = [];
  const ltfPtr = {};   // per-pair cursor into the LTF series (monotonic)
  for (const t of targetAnchors) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const hr  = d.getUTCHours();
    if (dow === 6) continue;
    if (dow === 0 && hr < 21) continue;

    const agg = {}; CCYS.forEach(k => agg[k] = 0);
    let contributing = 0;
    for (const inst of PAIRS) {
      const s = pairScores[inst].get(t);
      if (s === undefined) continue;
      contributing++;
      const [base, quote] = inst.split('_');
      agg[base]  += s;
      agg[quote] -= s;
    }
    if (contributing < PAIRS.length * 0.7) continue;
    const currencies = {};
    for (const k of CCYS) currencies[k] = agg[k] / 7;
    const breaks = {};
    for (const inst of PAIRS) {
      const b = pairBreaks[inst].get(t);
      if (!b) continue;
      // M5 confirms against its own structure — reuse the same candle series
      // that produced the break. ltfPtr advances monotonically because
      // anchors are walked in ascending order.
      const seq = candles[inst] || [];
      let p = ltfPtr[inst] || 0;
      while (p < seq.length && seq[p].ms <= t) p++;
      ltfPtr[inst] = p;
      const win = seq.slice(Math.max(0, p - SWING_WINDOW), p);
      const confirm = swingConfirm(win, b.direction, SWING_K, SWINGS_NEEDED);
      breaks[inst] = Object.assign({}, b, { confirm, confirmTf: LTF });
    }
    rows.push({ time: d.toISOString(), currencies, breaks });
  }

  res.json({
    from, to,
    snapshots: rows.length,
    duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    errors: errors.slice(0, 5),
    rows,
  });
};

module.exports.maxDuration = 300;
