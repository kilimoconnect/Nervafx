'use strict';

/**
 * GET /api/market-pressure  — Multi-Timeframe Market Pressure Ranking (MPR)
 *
 * For each of 28 pairs, measures W1/D1/H4 candle pressure vs the current price:
 *   direction  = sign(price - candle_open)
 *   strength   = min(1, |price - candle_open| / ATR14(timeframe))
 *   score      = direction * strength                          (-1 .. +1)
 * Pairs are VALID only when W1, D1 and H4 agree in direction. The weighted
 * trend score = 0.50*W1 + 0.30*D1 + 0.20*H4, ranked by |trend score|. Rank
 * change and score momentum are measured against the snapshot 1 hour earlier.
 *
 * W1/D1/H4 are synthesized from stored H1 candles (no native feed) and a new
 * card is produced on every H1 close (hourly). Live (no ?date) evaluates as of
 * now; ?date=YYYY-MM-DD gives that day's hourly cards.
 */

const { cors, getClient } = require('./_db');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];
const CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const HOUR = 3600000, H4_MS = 4 * HOUR, DAY = 24 * HOUR;
const WEIGHTS = { w1: 0.50, d1: 0.30, h4: 0.20 };

const floorTo = (ms, size) => Math.floor(ms / size) * size;
// Monday 00:00 UTC of the week containing ms (weekly candle anchor).
function weekFloor(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7;   // Mon=0 … Sun=6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
}

// Group ascending H1 candles into buckets keyed by floorFn(ms) (open = first,
// close = last). floorFn maps a timestamp to its bucket start.
function bucketize(h1Arr, floorFn) {
  const m = new Map();
  for (const c of h1Arr) {
    const bs = floorFn(c.ms);
    const b = m.get(bs);
    if (!b) m.set(bs, { start: bs, open: c.open, high: c.high, low: c.low, close: c.close });
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  return [...m.values()].sort((a, b) => a.start - b.start);
}

// True-range ATR over the last 14 candles.
function atr14(candles) {
  if (candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const last = trs.slice(-14);
  return last.length ? last.reduce((a, b) => a + b, 0) / last.length : null;
}

function marketState(absScore) {
  if (absScore > 0.70) return 'STRONG';
  if (absScore >= 0.50) return 'MODERATE';
  if (absScore >= 0.30) return 'WEAK';
  return 'IGNORE';
}

// One pair's pressure at price time `pms`, from its H1 array + map. ATR is
// memoized per (pair, period) via atrCache since it only changes at boundaries.
function pairPressure(price, pms, inst, h1Arr, h1Map, atrCache) {
  const wkStart = weekFloor(pms);
  const dayStart = floorTo(pms, DAY);
  const h4Start = floorTo(pms, H4_MS);

  const openAt = (t) => (h1Map[t] !== undefined ? h1Map[t].open : null);
  const w1Open = openAt(wkStart), d1Open = openAt(dayStart), h4Open = openAt(h4Start);
  if (w1Open == null || d1Open == null || h4Open == null) return null;

  const memo = (k, fn) => { const key = inst + k; if (atrCache[key] === undefined) atrCache[key] = fn(); return atrCache[key]; };
  const w1Atr = memo('W' + wkStart,  () => atr14(bucketize(h1Arr.filter(c => c.ms < wkStart),  weekFloor)));
  const d1Atr = memo('D' + dayStart, () => atr14(bucketize(h1Arr.filter(c => c.ms < dayStart), (ms) => floorTo(ms, DAY))));
  const h4Atr = memo('4' + h4Start,  () => atr14(bucketize(h1Arr.filter(c => c.ms < h4Start),  (ms) => floorTo(ms, H4_MS))));
  if (!w1Atr || !d1Atr || !h4Atr) return null;

  const mk = (open, atr) => {
    const dist = price - open;
    const dir = dist > 0 ? 1 : dist < 0 ? -1 : 0;
    const strength = Math.min(1, Math.abs(dist) / atr);
    return { dir, score: dir * strength };
  };
  const w1 = mk(w1Open, w1Atr), d1 = mk(d1Open, d1Atr), h4 = mk(h4Open, h4Atr);
  const aligned = w1.dir !== 0 && w1.dir === d1.dir && d1.dir === h4.dir;
  const trendScore = WEIGHTS.w1 * w1.score + WEIGHTS.d1 * d1.score + WEIGHTS.h4 * h4.score;
  return {
    aligned,
    direction: trendScore >= 0 ? 'BUY' : 'SELL',
    trendScore: +trendScore.toFixed(3),
    w1: +w1.score.toFixed(3), d1: +d1.score.toFixed(3), h4: +h4.score.toFixed(3),
  };
}

// Did the closed H1 candle at `idx` break the structure (high/low range) of the
// previous six H1 candles? +1 = close above prior 6 highs, -1 = below, 0 = no.
function structureBreak(h1, idx) {
  if (idx < 6) return 0;
  let hi = -Infinity, lo = Infinity;
  for (let k = idx - 6; k < idx; k++) { if (h1[k].high > hi) hi = h1[k].high; if (h1[k].low < lo) lo = h1[k].low; }
  const close = h1[idx].close;
  if (close > hi) return 1;
  if (close < lo) return -1;
  return 0;
}

// Every pair with valid pressure at price time `pms` (unranked, aligned flag
// on each). Callers rank/filter; currency aggregation needs all pairs.
function snapshotAt(pms, cache, atrCache) {
  const rows = [];
  for (const inst of PAIRS) {
    const c = cache[inst];
    if (!c) continue;
    let price = null, idx = -1;
    for (let i = c.h1.length - 1; i >= 0; i--) { if (c.h1[i].ms <= pms) { price = c.h1[i].close; idx = i; break; } }
    if (price == null) continue;
    const p = pairPressure(price, pms, inst, c.h1, c.h1Map, atrCache);
    if (!p) continue;
    rows.push({ pair: inst.replace('_', '/'), instrument: inst, breakDir: structureBreak(c.h1, idx), ...p });
  }
  return rows;
}

// Net per-currency pressure: average of its pairs' trend scores (base +, quote
// -) across all valid pairs. Ranked strongest → weakest (signed).
function aggregateCurrencies(rows) {
  const acc = {}; for (const c of CCYS) acc[c] = { sum: 0, n: 0, pos: 0, neg: 0 };
  for (const r of rows) {
    const [base, quote] = r.instrument.split('_');
    if (acc[base]) { acc[base].sum += r.trendScore; acc[base].n++; if (r.trendScore > 0) acc[base].pos++; else if (r.trendScore < 0) acc[base].neg++; }
    if (acc[quote]) { acc[quote].sum -= r.trendScore; acc[quote].n++; if (r.trendScore < 0) acc[quote].pos++; else if (r.trendScore > 0) acc[quote].neg++; }
  }
  const out = [];
  for (const c of CCYS) {
    const a = acc[c];
    if (!a.n) continue;
    const score = a.sum / a.n;
    out.push({
      currency: c, score: +score.toFixed(3), pairs: a.n,
      agree: score >= 0 ? a.pos : a.neg,           // pairs backing the net direction
      state: marketState(Math.abs(score)),
    });
  }
  out.sort((a, b) => b.score - a.score);           // strongest first
  out.forEach((r, i) => { r.rank = i + 1; });
  return out;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    const now = Date.now();
    // History: ?at=<ISO> snapshots as of that moment; ?date=YYYY-MM-DD gives
    // that day's hourly cards.
    const qAt = req.query?.at;
    const qDate = req.query?.date;
    let evalMs = now;
    if (qAt) {
      const t = new Date(qAt).getTime();
      if (!isNaN(t)) evalMs = Math.min(t, now);
    } else if (qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate)) {
      const end = new Date(qDate + 'T00:00:00Z').getTime() + DAY;
      evalMs = Math.min(end, now);
    }
    // W1 ATR14 needs ~14 weeks of history; pull 120 days of H1 (+ buffer).
    const h1Since = new Date(evalMs - 120 * DAY).toISOString();
    const until = new Date(evalMs).toISOString();

    const PAGE = 1000;
    const cache = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const out = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
            .gte('time', h1Since).lte('time', until)
            .order('time', { ascending: true })
            .range(off, off + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          out.push(...data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return { inst, h1raw: out };
      }));
      for (const { inst, h1raw } of results) {
        const h1 = h1raw.map(c => ({ ms: new Date(c.time).getTime(), open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
        const h1Map = {}; for (const c of h1) h1Map[c.ms] = c;
        cache[inst] = { h1, h1Map };
      }
    }

    // Window of hourly snapshot cards. A selected ?date covers that whole day;
    // otherwise the last 24h ending at evalMs. Each card ranks its valid pairs
    // and surfaces the tradable ones, with rank change / momentum vs the prior card.
    let windowStart = evalMs - DAY;
    if (!qAt && qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate)) {
      windowStart = new Date(qDate + 'T00:00:00Z').getTime();
    }
    // Snapshot at each H1 candle that has actually CLOSED (h1 holds only
    // complete candles), so a card's close time never sits in the future. One
    // candle before the window is kept as warm-up for the first rank delta.
    const inWindow = new Set();
    let warmup = 0;
    for (const inst of PAIRS) {
      for (const c of (cache[inst]?.h1 || [])) {
        if (c.ms > evalMs) continue;
        if (c.ms >= windowStart) inWindow.add(c.ms);
        else if (c.ms > warmup) warmup = c.ms;
      }
    }
    const steps = [...inWindow].sort((a, b) => a - b);
    if (warmup) steps.unshift(warmup);

    const atrCache = {};
    const cards = [];
    let prevBy = null, prevCur = null;
    for (const o of steps) {
      const all = snapshotAt(o, cache, atrCache);
      if (!all.length) continue;

      // Pairs: aligned only (W1=D1=H4), ranked by |score|.
      const aligned = all.filter(r => r.aligned)
        .sort((a, b) => Math.abs(b.trendScore) - Math.abs(a.trendScore));
      aligned.forEach((r, i) => { r.rank = i + 1; });
      const byInst = {};
      for (const r of aligned) {
        const p = prevBy ? prevBy[r.instrument] : null;
        r.rankChange = p ? p.rank - r.rank : null;        // + = climbing
        r.momentum = p ? +(r.trendScore - p.trendScore).toFixed(3) : null;
        r.state = marketState(Math.abs(r.trendScore));
        byInst[r.instrument] = r;
      }
      prevBy = byInst;

      // Currencies: net pressure across all valid pairs, ranked strong → weak.
      const currencies = aggregateCurrencies(all);
      const byCcy = {};
      for (const r of currencies) {
        const p = prevCur ? prevCur[r.currency] : null;
        r.rankChange = p ? p.rank - r.rank : null;
        r.momentum = p ? +(r.score - p.score).toFixed(3) : null;
        byCcy[r.currency] = r;
      }
      prevCur = byCcy;

      if (o < windowStart) continue;                      // warm-up only
      // Tradable = MODERATE/STRONG (|score| >= 0.50) AND the closed H1 candle
      // broke the last-6-candle structure in the pair's own direction.
      const tradable = aligned.filter(r =>
        Math.abs(r.trendScore) >= 0.50 &&
        ((r.trendScore >= 0 && r.breakDir === 1) || (r.trendScore < 0 && r.breakDir === -1)));
      cards.push({
        time: new Date(o).toISOString(),
        signalTime: new Date(o + HOUR).toISOString(),
        validCount: aligned.length,
        tradableCount: tradable.length,
        top: tradable,                 // full ranked list; client filters + slices to 5
        currencies,
      });
    }
    cards.reverse();                                      // newest first

    res.json({
      total: PAIRS.length,
      weights: WEIGHTS,
      count: cards.length,
      snapshots: cards,
    });
  } catch (e) {
    console.error('[market-pressure]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 120;
