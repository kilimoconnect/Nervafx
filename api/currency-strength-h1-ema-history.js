'use strict';

/**
 * GET /api/currency-strength-h1-ema-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Hourly per-currency strength from H1 close vs EMA20/EMA50 alignment,
 * across the requested window. Pre-fetches every pair's H1 candles once
 * (with a warmup buffer for EMA50) and walks hourly anchors in memory —
 * same shape as /api/acceleration-v4-history.
 *
 * Response:
 *   {
 *     from, to,
 *     hours: number,
 *     rows: [{ time, currencies: { USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD } }]
 *   }
 *
 * Values are strength/7 → bounded in [-1, +1].
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

// Rolling EMA — feed one value at a time, get the current EMA back.
function makeEma(period) {
  const k = 2 / (period + 1);
  let seedBuf = [];
  let e = null;
  return function push(v) {
    if (e === null) {
      seedBuf.push(v);
      if (seedBuf.length === period) {
        e = seedBuf.reduce((a, b) => a + b, 0) / period;
      }
      return e;
    }
    e = v * k + e * (1 - k);
    return e;
  };
}

async function fetchAllH1(sb, inst, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({
      ms:   new Date(c.time).getTime(),
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

// Pip divisor: non-JPY pairs quote to 5 decimals so 1 pip = 0.0001; JPY
// pairs quote to 3 decimals so 1 pip = 0.01. Used to normalise body sizes
// across the 28 majors so the ranking is comparable.
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
  const end   = new Date(to   + 'T23:00:00Z');
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'invalid dates' });

  const t0 = Date.now();
  const sb = getClient();

  // Need 51 candles of warmup for EMA50 → pull 5 extra days.
  const fetchSince = new Date(start.getTime() - 5 * 24 * 3600000).toISOString();
  const fetchUntil = new Date(end.getTime()   + 60 * 60000).toISOString();

  // Pre-fetch all 28 pairs, 7 at a time.
  const candles = {};
  const errors = [];
  for (let b = 0; b < PAIRS.length; b += 7) {
    const batch = PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try { candles[inst] = await fetchAllH1(sb, inst, fetchSince, fetchUntil); }
      catch (e) { errors.push(`${inst}: ${e.message}`); candles[inst] = []; }
    }));
  }

  // Walk each hour in [start, end] and compute per-currency strength.
  // We rebuild rolling EMAs by streaming through each pair's candles once
  // and snapshotting at every hour boundary we care about.
  const targetHours = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 3600000) targetHours.push(t);
  const targetSet = new Set(targetHours);

  // For each pair, compute score at each target hour AND record whether the
  // current H1 close broke the immediately-preceding H1's high (BUY-break)
  // or low (SELL-break). Also record the breaking bar's body size in pips
  // so the frontend can rank setups by the strongest break.
  const pairScores = {}; // { pair: Map<hourMs, score> }
  const pairBreaks = {}; // { pair: Map<hourMs, { direction, bodyPips }> }
  for (const inst of PAIRS) {
    const seq = candles[inst] || [];
    if (!seq.length) { pairScores[inst] = new Map(); pairBreaks[inst] = new Map(); continue; }
    const pushE20 = makeEma(20);
    const pushE50 = makeEma(50);
    const scoreMap = new Map();
    const breakMap = new Map();
    const pd = pipDiv(inst);
    let prev = null;
    for (const c of seq) {
      const e20 = pushE20(c.close);
      const e50 = pushE50(c.close);
      if (e20 != null && e50 != null && targetSet.has(c.ms)) {
        scoreMap.set(c.ms, alignmentScore(c.close, e20, e50));
        if (prev) {
          const bodyPips = Math.round((Math.abs(c.close - c.open) / pd) * 10) / 10;
          if      (c.close > prev.high) breakMap.set(c.ms, { direction: 'BUY',  bodyPips });
          else if (c.close < prev.low)  breakMap.set(c.ms, { direction: 'SELL', bodyPips });
        }
      }
      prev = c;
    }
    pairScores[inst] = scoreMap;
    pairBreaks[inst] = breakMap;
  }

  // Aggregate per hour across all 28 pairs.
  const rows = [];
  for (const h of targetHours) {
    // Skip weekend hours: Sat all day, Sun before 21:00 UTC.
    const d = new Date(h);
    const dow = d.getUTCDay();
    const hr  = d.getUTCHours();
    if (dow === 6) continue;
    if (dow === 0 && hr < 21) continue;

    const agg = {}; CCYS.forEach(k => agg[k] = 0);
    let contributing = 0;
    for (const inst of PAIRS) {
      const s = pairScores[inst].get(h);
      if (s === undefined) continue;
      contributing++;
      const [base, quote] = inst.split('_');
      agg[base]  += s;
      agg[quote] -= s;
    }
    if (contributing < PAIRS.length * 0.7) continue; // skip hours with too few pairs
    const currencies = {};
    for (const k of CCYS) currencies[k] = agg[k] / 7;
    // Per-anchor break map: pair → { direction, bodyPips } for pairs whose
    // current H1 broke the immediately-preceding H1's high/low. bodyPips is
    // the absolute body size of the breaking candle in pips, used to rank
    // setups.
    const breaks = {};
    for (const inst of PAIRS) {
      const b = pairBreaks[inst].get(h);
      if (b) breaks[inst] = b;
    }
    rows.push({ time: d.toISOString(), currencies, breaks });
  }

  res.json({
    from, to,
    hours: rows.length,
    duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    errors: errors.slice(0, 5),
    rows,
  });
};

module.exports.maxDuration = 300;
