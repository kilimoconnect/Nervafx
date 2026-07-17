'use strict';

/**
 * GET /api/mtre-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Historical Market Trend Respect Engine. For every hour in the window,
 * emits { time, mti, breadth, agreement, health, classification }. Uses the
 * same weighted Respect maths as /api/mtre; only the top-line rollup is
 * kept per row (per-pair details would balloon the payload).
 */

const { cors, getClient } = require('./_db');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function makeEmaSeries() {
  return function(period) {
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
  };
}

async function fetchAll(sb, inst, tf, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, close')
      .eq('instrument', inst).eq('timeframe', tf).eq('complete', true)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({ ms: new Date(c.time).getTime(), close: parseFloat(c.close) })));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// Per-pair Respect score at index i using precomputed EMA series.
function respectAt(closes, e20, e50, i, N) {
  const cur20 = e20[i], cur50 = e50[i];
  if (cur20 == null || cur50 == null) return null;
  const trend = cur20 > cur50 ? 'BUY' : cur20 < cur50 ? 'SELL' : null;
  if (!trend) return { trend: null, respect: 0 };
  const sig = trend === 'BUY' ? +1 : -1;
  let total = 0;
  for (let k = 0; k < N; k++) {
    const idx = i - k;
    if (idx < 20) break;
    const c = closes[idx], a20 = e20[idx], a50 = e50[idx];
    const a20prev = idx >= 5 ? e20[idx - 5] : null;
    if (a20 == null || a50 == null || a20prev == null) continue;
    const sideOk  = Math.sign(c - a20)      === sig ? 1 : 0;
    const stackOk = Math.sign(a20 - a50)    === sig ? 1 : 0;
    const slopeOk = Math.sign(a20 - a20prev) === sig ? 1 : 0;
    total += 0.40 * sideOk + 0.30 * stackOk + 0.30 * slopeOk;
  }
  return { trend, respect: Math.round((total / N) * 100) };
}

function classify(health) {
  if (health >= 85) return 'TRENDING';
  if (health >= 70) return 'GOOD_TREND';
  if (health >= 50) return 'MIXED';
  return 'REVERSAL_CHOPPY';
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const from = req.query?.from;
  const to   = req.query?.to;
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });

  const start = new Date(from + 'T00:00:00Z');
  let end     = new Date(to   + 'T23:00:00Z');
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'invalid dates' });
  const nowH = Math.floor(Date.now() / 3600000) * 3600000 - 3600000;
  if (end.getTime() > nowH) end = new Date(nowH);

  const t0 = Date.now();
  const sb = getClient();

  // Fetch buffer covers EMA50 warmup on both TFs.
  const fetchSince = new Date(start.getTime() - 5 * 24 * 3600000).toISOString();
  const fetchUntilH1 = new Date(end.getTime() + 60 * 60000).toISOString();
  // For M15 sampling at every hour we still fetch the full M15 series so we
  // can find the M15 candle whose time == the hour anchor.
  const fetchUntilM15 = fetchUntilH1;

  // Per pair: full H1 + M15 series with pre-built EMA series.
  const perPair = {};
  const errors = [];
  const makeEma = makeEmaSeries();
  for (let b = 0; b < PAIRS.length; b += 7) {
    const batch = PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try {
        const [h1, m15] = await Promise.all([
          fetchAll(sb, inst, 'H1',  fetchSince, fetchUntilH1),
          fetchAll(sb, inst, 'M15', fetchSince, fetchUntilM15),
        ]);
        // Build EMA series aligned to closes.
        function build(seq) {
          const closes = seq.map(c => c.close);
          const e20 = new Array(closes.length).fill(null);
          const e50 = new Array(closes.length).fill(null);
          const pushE20 = makeEma(20);
          const pushE50 = makeEma(50);
          for (let i = 0; i < closes.length; i++) {
            e20[i] = pushE20(closes[i]);
            e50[i] = pushE50(closes[i]);
          }
          // Index by ms.
          const byMs = new Map();
          for (let i = 0; i < seq.length; i++) byMs.set(seq[i].ms, i);
          return { seq, closes, e20, e50, byMs };
        }
        perPair[inst] = { h1: build(h1), m15: build(m15) };
      } catch (e) {
        errors.push(`${inst}: ${e.message}`);
        perPair[inst] = { h1: null, m15: null };
      }
    }));
  }

  // Walk each hourly anchor. For each pair look up the H1 candle at that
  // exact anchor and the M15 candle whose ms is exactly the anchor (M15 grid
  // includes every :00, :15, :30, :45 so :00 always exists on a trading hour).
  const rows = [];
  const stepMs = 3600000;
  const scanStart = start.getTime();
  for (let t = scanStart; t <= end.getTime(); t += stepMs) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const hr  = d.getUTCHours();
    if (dow === 6) continue;
    if (dow === 0 && hr < 21) continue;

    let respectSum = 0, respectCount = 0;
    let strongCount = 0;
    let agreeCount  = 0;
    for (const inst of PAIRS) {
      const pp = perPair[inst];
      if (!pp || !pp.h1 || !pp.m15) continue;
      const h1i  = pp.h1.byMs.get(t);
      const m15i = pp.m15.byMs.get(t);
      if (h1i == null || m15i == null) continue;
      const h1r  = respectAt(pp.h1.closes,  pp.h1.e20,  pp.h1.e50,  h1i,  10);
      const m15r = respectAt(pp.m15.closes, pp.m15.e20, pp.m15.e50, m15i, 10);
      if (!h1r || !m15r) continue;
      const combined = (h1r.respect + m15r.respect) / 2;
      respectSum += combined;
      respectCount++;
      if (combined > 80) strongCount++;
      if (h1r.trend && m15r.trend && h1r.trend === m15r.trend) agreeCount++;
    }
    if (respectCount < PAIRS.length * 0.7) continue;
    const mti     = Math.round(respectSum / respectCount);
    const breadth = Math.round((strongCount / respectCount) * 100);
    const agree   = Math.round((agreeCount  / respectCount) * 100);
    const health  = Math.round(0.40 * mti + 0.35 * breadth + 0.25 * agree);
    rows.push({
      time: d.toISOString(),
      mti, breadth, agreement: agree, health,
      classification: classify(health),
    });
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
