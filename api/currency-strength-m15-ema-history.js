'use strict';

/**
 * GET /api/currency-strength-m15-ema-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Per-currency M15 EMA strength across the requested window, one snapshot
 * every 15 minutes. Same maths as /api/currency-strength-h1-ema-history —
 * pre-fetches every pair's M15 candles once (with a warmup buffer for
 * EMA50), streams through them with rolling EMAs, and snapshots at every
 * 15-min anchor.
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
const STEP = 15 * 60 * 1000;

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

async function fetchAllM15(sb, inst, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', inst).eq('timeframe', 'M15').eq('complete', true)
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
  let end     = new Date(to   + 'T23:45:00Z');
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
      try { candles[inst] = await fetchAllM15(sb, inst, fetchSince, fetchUntil); }
      catch (e) { errors.push(`${inst}: ${e.message}`); candles[inst] = []; }
    }));
  }

  const targetAnchors = [];
  for (let t = start.getTime(); t <= end.getTime(); t += STEP) targetAnchors.push(t);
  const targetSet = new Set(targetAnchors);

  // Break check widens to the last 6 M15 candles: current close must beat
  // max(high) (BUY) or drop below min(low) (SELL) of the preceding 6 bars.
  const BREAK_LOOKBACK = 6;
  const pairScores = {};
  const pairBreaks = {}; // { pair: Map<ms, { direction, bodyPips }> }
  for (const inst of PAIRS) {
    const seq = candles[inst] || [];
    if (!seq.length) { pairScores[inst] = new Map(); pairBreaks[inst] = new Map(); continue; }
    const pushE20 = makeEma(20);
    const pushE50 = makeEma(50);
    const scoreMap = new Map();
    const breakMap = new Map();
    const pd = pipDiv(inst);
    const prevWin = [];
    for (const c of seq) {
      const e20 = pushE20(c.close);
      const e50 = pushE50(c.close);
      if (e20 != null && e50 != null && targetSet.has(c.ms)) {
        scoreMap.set(c.ms, alignmentScore(c.close, e20, e50));
        if (prevWin.length >= BREAK_LOOKBACK) {
          let maxH = -Infinity, minL = Infinity;
          for (const p of prevWin) { if (p.high > maxH) maxH = p.high; if (p.low < minL) minL = p.low; }
          const bodyPips = Math.round((Math.abs(c.close - c.open) / pd) * 10) / 10;
          if      (c.close > maxH) breakMap.set(c.ms, { direction: 'BUY',  bodyPips });
          else if (c.close < minL) breakMap.set(c.ms, { direction: 'SELL', bodyPips });
        }
      }
      prevWin.push(c);
      if (prevWin.length > BREAK_LOOKBACK) prevWin.shift();
    }
    pairScores[inst] = scoreMap;
    pairBreaks[inst] = breakMap;
  }

  const rows = [];
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
      if (b) breaks[inst] = b;
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
