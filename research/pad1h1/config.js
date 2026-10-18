'use strict';

/**
 * PA_D1_H1_CONTINUATION — configuration. Daily structural trend → H1 pullback &
 * continuation. SEPARATE strategy id / version / results from PA_W1_H4_CONTINUATION,
 * but it REUSES the shared, verified core (swings, engine, trend context, trade sim,
 * metrics) and the same UTC-anchored, DST-invariant boundary conventions.
 *
 * Timeframe boundaries (documented):
 *   • Entry candles = stored H1 (used directly; completed = closeMs ≤ t).
 *   • Trend candles = D1, aggregated from H1 on UTC DAY boundaries (00:00 UTC →
 *     next 00:00 UTC). This is DST-invariant by construction. A *broker daily close*
 *     (e.g. 17:00 New York / 21:00–22:00 UTC, which shifts with US DST) is a
 *     documented future option and would change ONLY these constants.
 *   • A daily candle is COMPLETE only once its UTC day has fully elapsed as-of t; a
 *     forming daily candle never establishes trend. Weekend days have no H1 and are
 *     simply absent (a scheduled closure, distinct from missing data); days with
 *     fewer than 24 H1 are flagged `partial` (high/low still real, never fabricated).
 *
 * Expiry / exit windows are "30 completed H1 candles" here (the config numbers are
 * the same 30; they now count H1 bars). UNVALIDATED research settings.
 */

const shared = require('../paw1h4/config');

const CONFIG = Object.assign({}, shared.CONFIG, {
  strategyId: 'PA_D1_H1_CONTINUATION',
  version: 'pad1h1-1.0.0',
  trendTimeframe: 'D1',
  entryTimeframe: 'H1',
  // deep-copy the nested defaults so tuning one strategy never leaks into the other
  execution: Object.assign({}, shared.CONFIG.execution),
  swing: Object.assign({}, shared.CONFIG.swing),
});

module.exports = { CONFIG, PAIRS: shared.PAIRS, pipSize: shared.pipSize };
