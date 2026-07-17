'use strict';

/**
 * GET /api/mtre-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Historical MTRE. For every hour in the window, emits the top-line rollup
 * for the redesigned engine (see api/mtre.js). Pre-fetches every pair's H1
 * and M15 candles once with rolling EMAs, snapshots at each hour, then
 * evaluates the four Respect components.
 */

const { cors, getClient } = require('./_db');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

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

async function fetchAll(sb, inst, tf, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', inst).eq('timeframe', tf).eq('complete', true)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({
      ms: new Date(c.time).getTime(),
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

// Structure count at candle index i, looking back N candles.
function structureAt(seq, i, direction, N) {
  if (i < N) return 0;
  let count = 0;
  for (let k = i - N + 1; k <= i; k++) {
    const c = seq[k], p = seq[k - 1];
    if (direction === 'BUY') {
      if (c.high > p.high && c.low > p.low) count++;
    } else {
      if (c.high < p.high && c.low < p.low) count++;
    }
  }
  return count / N;
}

// Per-pair Respect at index i using the pre-built EMA series.
function respectAt(seq, closes, e20, e50, i) {
  const cur20 = e20[i], cur50 = e50[i];
  if (cur20 == null || cur50 == null) return null;
  const cur = closes[i];
  let direction, priceE20, priceE50;
  if (cur20 > cur50) {
    direction = 'BUY';
    priceE20 = cur > cur20 ? 1 : 0;
    priceE50 = cur > cur50 ? 1 : 0;
  } else if (cur20 < cur50) {
    direction = 'SELL';
    priceE20 = cur < cur20 ? 1 : 0;
    priceE50 = cur < cur50 ? 1 : 0;
  } else {
    return { direction: null, respect: 0 };
  }
  const structure = structureAt(seq, i, direction, 10);
  const respect = Math.round(((1 + priceE20 + priceE50 + structure) / 4) * 100);
  return { direction, respect };
}

function classify(mtre) {
  if (mtre >= 85) return 'STRONG_TRENDING';
  if (mtre >= 70) return 'HEALTHY_TREND';
  if (mtre >= 50) return 'DEVELOPING';
  if (mtre >= 30) return 'WEAK_TREND';
  return 'CHAOTIC';
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

  const fetchSince    = new Date(start.getTime() - 5 * 24 * 3600000).toISOString();
  const fetchUntilH1  = new Date(end.getTime() + 60 * 60000).toISOString();
  const fetchUntilM15 = fetchUntilH1;

  const perPair = {};
  const errors = [];
  for (let b = 0; b < PAIRS.length; b += 7) {
    const batch = PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try {
        const [h1, m15] = await Promise.all([
          fetchAll(sb, inst, 'H1',  fetchSince, fetchUntilH1),
          fetchAll(sb, inst, 'M15', fetchSince, fetchUntilM15),
        ]);
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

  const rows = [];
  const stepMs = 3600000;
  const scanStart = start.getTime();
  for (let t = scanStart; t <= end.getTime(); t += stepMs) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const hr  = d.getUTCHours();
    if (dow === 6) continue;
    if (dow === 0 && hr < 21) continue;

    let h1Sum = 0, m15Sum = 0, alignSum = 0, count = 0;
    let strongBuy = 0, strongSell = 0;
    for (const inst of PAIRS) {
      const pp = perPair[inst];
      if (!pp || !pp.h1 || !pp.m15) continue;
      const h1i  = pp.h1.byMs.get(t);
      const m15i = pp.m15.byMs.get(t);
      if (h1i == null || m15i == null) continue;
      const h1r  = respectAt(pp.h1.seq,  pp.h1.closes,  pp.h1.e20,  pp.h1.e50,  h1i);
      const m15r = respectAt(pp.m15.seq, pp.m15.closes, pp.m15.e20, pp.m15.e50, m15i);
      if (!h1r || !m15r) continue;
      count++;
      h1Sum  += h1r.respect;
      m15Sum += m15r.respect;
      const dirsMatch = h1r.direction && m15r.direction && h1r.direction === m15r.direction;
      alignSum += dirsMatch ? (h1r.respect + m15r.respect) / 2 : 0;
      if (h1r.direction === 'BUY'  && h1r.respect >= 70) strongBuy++;
      if (h1r.direction === 'SELL' && h1r.respect >= 70) strongSell++;
    }
    if (count < PAIRS.length * 0.7) continue;
    const h1Avg  = Math.round(h1Sum  / count);
    const m15Avg = Math.round(m15Sum / count);
    const align  = Math.round(alignSum / count);
    const mtre   = Math.round(0.40 * h1Avg + 0.40 * m15Avg + 0.20 * align);
    rows.push({
      time: d.toISOString(),
      h1AvgRespect: h1Avg,
      m15AvgRespect: m15Avg,
      alignment: align,
      strongBuy,
      strongSell,
      mtre,
      state: classify(mtre),
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
