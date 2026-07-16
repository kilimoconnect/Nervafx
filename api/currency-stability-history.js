'use strict';

/**
 * GET /api/currency-stability-history?from=YYYY-MM-DD&to=YYYY-MM-DD[&tf=m5|m15|h1]
 *
 * Historical CSE — walks every anchor in [from, to] on the requested TF and
 * emits an event whenever at least one qualified pair is produced (i.e. at
 * least one leader-aligned BUY or SELL). Uses the same maths as
 * /api/currency-stability but pre-fetches once across the whole window.
 *
 * Response:
 *   { from, to, tf, anchors, qualified_anchors, duration_sec,
 *     rows: [{ time, leaders:{strong,weak}, pairs:[{pair, direction, score100, ...}] }] }
 */

const { cors, getClient } = require('./_db');
const { computeCSE, CCYS, PAIRS } = require('./_currency-stability');

const TF_STEP_MS = { M5: 5 * 60 * 1000, M15: 15 * 60 * 1000, H1: 60 * 60 * 1000 };

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

function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50)  return +1.0;
  if (close < e20 && e20 < e50)  return -1.0;
  if (close > e20 && e20 <= e50) return +0.5;
  if (close < e20 && e20 >= e50) return -0.5;
  return 0;
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

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const from = req.query?.from;
  const to   = req.query?.to;
  const tf   = (req.query?.tf || 'm15').toUpperCase();
  if (!from || !to)   return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });
  if (!TF_STEP_MS[tf]) return res.status(400).json({ error: 'tf must be m5, m15, or h1' });
  const step = TF_STEP_MS[tf];

  const start = new Date(from + 'T00:00:00Z');
  let end     = new Date(to   + 'T23:59:59Z');
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'invalid dates' });
  const nowLast = Math.floor(Date.now() / step) * step - step;
  if (end.getTime() > nowLast) end = new Date(nowLast);

  const t0 = Date.now();
  const sb = getClient();

  // 3-day warmup buffer for EMA50 on any TF.
  const fetchSince = new Date(start.getTime() - 3 * 24 * 3600000).toISOString();
  const fetchUntil = new Date(end.getTime()   + 60 * 60000).toISOString();

  const cache = {};
  const errors = [];
  for (let b = 0; b < PAIRS.length; b += 7) {
    const batch = PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try { cache[inst] = await fetchAll(sb, inst, tf, fetchSince, fetchUntil); }
      catch (e) { errors.push(`${inst}: ${e.message}`); cache[inst] = []; }
    }));
  }

  // Build a Map<anchorMs, {currencies}> for every target anchor by streaming.
  // Also include a 4-step warmup before `start` so the earliest target has
  // its full 5-snapshot window available.
  const warmupStart = start.getTime() - 4 * step;
  const targetAnchors = [];
  for (let t = warmupStart; t <= end.getTime(); t += step) targetAnchors.push(t);
  const targetSet = new Set(targetAnchors);

  const pairScores = {};
  for (const inst of PAIRS) {
    const seq = cache[inst] || [];
    if (!seq.length) { pairScores[inst] = new Map(); continue; }
    const pushE20 = makeEma(20);
    const pushE50 = makeEma(50);
    const map = new Map();
    for (const c of seq) {
      const e20 = pushE20(c.close);
      const e50 = pushE50(c.close);
      if (e20 == null || e50 == null) continue;
      if (targetSet.has(c.ms)) map.set(c.ms, alignmentScore(c.close, e20, e50));
    }
    pairScores[inst] = map;
  }

  // Aggregate to per-anchor snapshot list (currencies per anchor).
  const snapshotByMs = {};
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
    snapshotByMs[t] = { time: d.toISOString(), currencies };
  }

  // Walk each anchor in the user's requested window and run CSE using the
  // 5 preceding snapshots (inclusive of the anchor itself).
  const rows = [];
  const scanStart = start.getTime();
  for (let t = scanStart; t <= end.getTime(); t += step) {
    const window = [];
    for (let k = 4; k >= 0; k--) {
      const w = snapshotByMs[t - k * step];
      if (!w) break;
      window.push(w);
    }
    if (window.length < 5) continue;
    const cse = computeCSE(window);
    if (!cse) continue;
    // Only emit anchors where at least one pair is leader-qualified.
    const qualified = cse.pairs.filter(p => p.direction != null);
    if (!qualified.length) continue;
    rows.push({
      time: new Date(t).toISOString(),
      leaders: cse.leaders,
      pairs: qualified.slice(0, 8).map(p => ({
        pair: p.pair, instrument: p.instrument, direction: p.direction,
        score100: p.score100,
        base:  { code: p.base.code,  css: p.base.css  },
        quote: { code: p.quote.code, css: p.quote.css },
      })),
      snapshotEnd: cse.windowEnd,
    });
  }

  res.json({
    from, to, tf,
    anchors: targetAnchors.length,
    qualified_anchors: rows.length,
    duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    errors: errors.slice(0, 5),
    rows,
  });
};

module.exports.maxDuration = 300;
