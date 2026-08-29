'use strict';

/**
 * NervaFX Currency Movement Engine (30M) — M30 (synthesized) + M15 candle access.
 *
 * backtest_candles has no native M30, so M30 is synthesized by bucketing two
 * completed M15 candles into one M30 (open=first, close=last, high/low=extremes).
 * M15 is the micro layer. Completed candles only; reuses the H1 engine's pure
 * fetchClosed.
 */

const { BASE_MS, MICRO_MS } = require('./_cme30-constants');
const { fetchClosed } = require('./_cme-data');

/** Bucket ascending completed M15 candles into fully-closed M30 candles ≤ evalMs. */
function synthM30(m15, evalMs) {
  const buckets = new Map();
  for (const c of m15) {
    const bs = Math.floor(c.openMs / BASE_MS) * BASE_MS;
    const b = buckets.get(bs);
    if (!b) buckets.set(bs, { openMs: bs, time: new Date(bs).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close });
    else { if (c.high > b.high) b.high = c.high; if (c.low < b.low) b.low = c.low; b.close = c.close; }
  }
  return [...buckets.values()]
    .filter((b) => b.openMs + BASE_MS <= evalMs)   // fully-closed M30 only
    .sort((a, b) => a.openMs - b.openMs);
}

/**
 * Fetch M15, synthesize M30 (primary) + keep M15 (micro) for one pair. Returns
 * candle ARRAYS on `m30`/`m15` plus per-timeframe `meta`.
 */
async function fetchPair30(sb, pair, evalMs, opts) {
  opts = opts || {};
  const m15r = await fetchClosed(sb, pair, 'M15', evalMs, MICRO_MS, opts.m15Limit || 800);
  const m30 = synthM30(m15r.candles, evalMs);
  return {
    m30,
    m15: m15r.candles,
    meta: {
      m30: { count: m30.length },
      m15: { count: m15r.candles.length, rejected: m15r.rejected, gaps: m15r.gaps },
    },
  };
}

module.exports = { synthM30, fetchPair30 };
