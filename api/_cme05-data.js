'use strict';

/**
 * NervaFX Currency Movement Engine (5M) — M5 candle access.
 *
 * M5 is the primary (and only) timeframe. Completed candles only; reuses the H1
 * engine's pure fetchClosed. Needs enough history for a 60-candle BOS window +
 * ATR20 + the day-to-date span (up to ~288 M5).
 */

const { BASE_MS } = require('./_cme05-constants');
const { fetchClosed } = require('./_cme-data');

/** Fetch M5 (primary) for one pair. Returns candle ARRAY on `m5` plus `meta`. */
async function fetchPair05(sb, pair, evalMs, opts) {
  opts = opts || {};
  const m5r = await fetchClosed(sb, pair, 'M5', evalMs, BASE_MS, opts.m5Limit || 1100);
  return {
    m5: m5r.candles,
    meta: { m5: { count: m5r.candles.length, rejected: m5r.rejected, gaps: m5r.gaps } },
  };
}

module.exports = { fetchPair05 };
