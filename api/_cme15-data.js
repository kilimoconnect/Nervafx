'use strict';

/**
 * NervaFX Currency Movement Engine (15M twin) — M15 + M5 candle access.
 *
 * Primary timeframe is M15; M5 is the micro-confirmation layer. Completed
 * candles only, deduped, malformed OHLC rejected, gaps flagged. Reuses the pure
 * `filterClosed` from the H1 engine's data module and the shared Supabase
 * client — no new candle-parsing logic.
 */

const { M15_MS, M5_MS } = require('./_cme15-constants');
const { filterClosed, fetchClosed } = require('./_cme-data');

/**
 * Fetch M15 (primary) + M5 (micro) for one pair, completed-only. Returns candle
 * ARRAYS on `m15`/`m5` plus per-timeframe `meta`.
 */
async function fetchPair15(sb, pair, evalMs, opts) {
  opts = opts || {};
  const [m15r, m5r] = await Promise.all([
    fetchClosed(sb, pair, 'M15', evalMs, M15_MS, opts.m15Limit || 700),
    fetchClosed(sb, pair, 'M5', evalMs, M5_MS, opts.m5Limit || 900),
  ]);
  return {
    m15: m15r.candles,
    m5: m5r.candles,
    meta: {
      m15: { count: m15r.candles.length, rejected: m15r.rejected, gaps: m15r.gaps },
      m5: { count: m5r.candles.length, rejected: m5r.rejected, gaps: m5r.gaps },
    },
  };
}

module.exports = { filterClosed, fetchClosed, fetchPair15 };
