'use strict';

/**
 * Index OHLC for a period + per-currency candle/breadth metrics. Index extremes are
 * sampled at the construction resolution (M15) — disclosed; pair OHLC cannot
 * reconstruct the simultaneous basket path, so intrabar synthetic highs/lows are not
 * claimed. Zero-range candles return "N/A — flat candle" rather than NaN.
 */

const { M15_MS, legsFor } = require('./config');
const { idxAtOrBefore } = require('./index-build');

/** Index candle over (startMs, endMs] for a currency. Open = carry at the start boundary. */
function periodCandle(built, ccy, startMs, endMs) {
  const openAt = idxAtOrBefore(built, ccy, startMs);
  if (!openAt) return { ok: false, reason: 'no index at open boundary' };
  const O = openAt.value;
  let H = O, L = O, C = O, lastMs = openAt.ms, n = 0;
  const tl = built.timeline, arr = built.index[ccy];
  // first index after startMs
  let i = openAt.idx + 1;
  for (; i < tl.length && tl[i] <= endMs; i++) { const v = arr[i]; if (v > H) H = v; if (v < L) L = v; C = v; lastMs = tl[i]; n++; }
  if (n === 0) return { ok: false, reason: 'no completed index observations in the period' };
  return { ok: true, open: O, high: H, low: L, close: C, openMs: startMs, closeMs: lastMs, nPoints: n, resolution: built.resolution };
}

function candleMetrics(candle, cfg) {
  const O = candle.open, H = candle.high, L = candle.low, C = candle.close, range = H - L;
  const ret = 100 * (C / O - 1);
  const direction = Math.abs(ret) <= cfg.unchangedPct ? 'unchanged' : (ret > 0 ? 'appreciation' : 'depreciation');
  if (!(range > 0)) return { returnPct: +ret.toFixed(4), direction, flat: true, note: 'N/A — flat candle', bodyPct: null, upperWickPct: null, lowerWickPct: null, closeLocationPct: null, rangePct: 0 };
  return {
    returnPct: +ret.toFixed(4), direction, flat: false,
    bodyPct: +(100 * Math.abs(C - O) / range).toFixed(2),
    upperWickPct: +(100 * (H - Math.max(O, C)) / range).toFixed(2),
    lowerWickPct: +(100 * (Math.min(O, C) - L) / range).toFixed(2),
    closeLocationPct: +(100 * (C - L) / range).toFixed(2),
    rangePct: +(100 * range / O).toFixed(4),
  };
}

/** Open-relative index path over (startMs, endMs] for a mini-chart. pct = 100·(v/open−1). */
function periodPath(built, ccy, startMs, endMs) {
  const openAt = idxAtOrBefore(built, ccy, startMs);
  if (!openAt) return { ok: false, reason: 'no index at open boundary', points: [] };
  const O = openAt.value, tl = built.timeline, arr = built.index[ccy];
  const points = [{ ms: startMs, pct: 0 }];
  for (let i = openAt.idx + 1; i < tl.length && tl[i] <= endMs; i++) points.push({ ms: tl[i], pct: 100 * (arr[i] / O - 1) });
  return { ok: points.length > 1, points, open: O };
}

/** Pair close at the last M15 close ≤ t. */
function pairCloseAtOrBefore(candles, t) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; const cm = candles[m].openMs + M15_MS; if (cm <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? null : candles[ans].close;
}

/** Breadth for a currency from ACTUAL pair returns over the matching period. */
function breadth(ccy, candlesByPair, startMs, endMs, cfg) {
  const legs = legsFor(ccy);
  let appreciated = 0, depreciated = 0, unchanged = 0; const missing = [], per = [];
  for (const leg of legs) {
    const cs = candlesByPair[leg.pair];
    const a = cs ? pairCloseAtOrBefore(cs, startMs) : null, b = cs ? pairCloseAtOrBefore(cs, endMs) : null;
    if (a == null || b == null || !(a > 0) || !(b > 0)) { missing.push(leg.pair); per.push({ pair: leg.pair, counterpart: leg.counterpart, orientedReturnPct: null, classification: 'missing' }); continue; }
    const oriented = leg.sign * Math.log(b / a);   // currency c's return vs counterpart j
    const cls = Math.abs(oriented) <= cfg.unchangedPairLogret ? 'unchanged' : (oriented > 0 ? 'appreciated' : 'depreciated');
    if (cls === 'appreciated') appreciated++; else if (cls === 'depreciated') depreciated++; else unchanged++;
    per.push({ pair: leg.pair, counterpart: leg.counterpart, role: leg.sign === 1 ? 'base' : 'quote', orientedReturnPct: +(100 * (Math.exp(oriented) - 1)).toFixed(4), classification: cls });
  }
  const valid = legs.length - missing.length;
  return { appreciated, depreciated, unchanged, coverage: { valid, total: 7, missing }, provisional: valid < 7, per };
}

module.exports = { periodCandle, candleMetrics, periodPath, pairCloseAtOrBefore, breadth };
