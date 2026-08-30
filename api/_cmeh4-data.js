'use strict';

/**
 * NervaFX Currency Movement Engine (H4) — H4 (synthesized) + H1 candle access.
 *
 * backtest_candles has no native H4, so H4 is synthesized by bucketing four
 * completed H1 candles into one H4 (open=first, close=last, high/low=extremes).
 * H1 is the micro layer. Completed candles only; reuses the H1 engine's pure
 * fetchClosed.
 */

const { BASE_MS, MICRO_MS } = require('./_cmeh4-constants');
const { fetchClosed } = require('./_cme-data');

/** Bucket ascending completed H1 candles into fully-closed H4 candles ≤ evalMs. */
function synthH4(h1, evalMs) {
  const buckets = new Map();
  for (const c of h1) {
    const bs = Math.floor(c.openMs / BASE_MS) * BASE_MS;
    const b = buckets.get(bs);
    if (!b) buckets.set(bs, { openMs: bs, time: new Date(bs).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close });
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  return [...buckets.values()]
    .filter((b) => b.openMs + BASE_MS <= evalMs)   // fully-closed H4 only
    .sort((a, b) => a.openMs - b.openMs);
}

/**
 * Fetch H1, synthesize H4 (primary) + keep H1 (micro) for one pair. Returns
 * candle ARRAYS on `h4`/`h1` plus per-timeframe `meta`.
 */
async function fetchPairH4(sb, pair, evalMs, opts) {
  opts = opts || {};
  const h1r = await fetchClosed(sb, pair, 'H1', evalMs, MICRO_MS, opts.h1Limit || 400);
  const h4 = synthH4(h1r.candles, evalMs);
  return {
    h4,
    h1: h1r.candles,
    meta: {
      h4: { count: h4.length },
      h1: { count: h1r.candles.length, rejected: h1r.rejected, gaps: h1r.gaps },
    },
  };
}

module.exports = { synthH4, fetchPairH4 };
