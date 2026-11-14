'use strict';

/**
 * Candle aggregation for the Breakout module. Stored base candles are M5/M15/H1 in
 * `backtest_candles`; D1/W1/MN1/H4 do not exist as rows and are aggregated from H1 on
 * EAT (UTC+3, no DST) boundaries (see config.TF). Every produced candle carries an
 * explicit `openMs` and `closeMs` so "completed candle" is unambiguous: a bucket is
 * COMPLETE once its `closeMs` has passed the evaluation cutoff. The still-forming final
 * bucket is excluded — the methodology uses completed, actual, unsmoothed OHLC only.
 *
 * Input rows are as returned by comparison/dbload.loadTf: ascending, completed H1
 * candles `{ openMs, open, high, low, close, volume? }` where openMs is the candle OPEN.
 */

const { TF } = require('./config');

/** Normalise stored H1 rows (add closeMs). Assumes ascending by openMs. */
function normaliseH1(h1Rows) {
  const t = TF.H1;
  return (h1Rows || []).map((r) => ({
    openMs: r.openMs, closeMs: r.openMs + t.ms,
    open: r.open, high: r.high, low: r.low, close: r.close,
    volume: r.volume == null ? null : r.volume,
    baseCount: 1,
  }));
}

/**
 * Aggregate ascending H1 rows into completed candles of timeframe `tf` on EAT boundaries.
 * Returns ascending `{ openMs, closeMs, open, high, low, close, volume, baseCount }`.
 * H1 is a pass-through (just adds closeMs). Buckets are formed by grouping consecutive H1
 * candles that share the same EAT bucket open; OHLC = first-open / max-high / min-low /
 * last-close, volume summed. No boundary is fabricated when a bucket has no H1 data (so
 * weekends / market closures simply produce no candle for that span).
 */
function aggregateEat(h1Rows, tf) {
  if (tf === 'H1') return normaliseH1(h1Rows);
  const meta = TF[tf];
  if (!meta) throw new Error('unknown timeframe: ' + tf);
  const rows = h1Rows || [];
  const out = [];
  let cur = null;
  for (const r of rows) {
    const bOpen = meta.boundary(r.openMs);
    if (!cur || cur.openMs !== bOpen) {
      if (cur) out.push(cur);
      cur = {
        openMs: bOpen, closeMs: meta.nextBoundary(bOpen),
        open: r.open, high: r.high, low: r.low, close: r.close,
        volume: r.volume == null ? null : r.volume, baseCount: 1,
      };
    } else {
      if (r.high > cur.high) cur.high = r.high;
      if (r.low < cur.low) cur.low = r.low;
      cur.close = r.close;
      if (r.volume != null) cur.volume = (cur.volume == null ? 0 : cur.volume) + r.volume;
      cur.baseCount += 1;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Keep only candles that are COMPLETE as of `asOfMs` — i.e. closeMs <= asOfMs. Drops the
 * still-forming final bucket and anything after the cutoff. No look-ahead: a candle is
 * included only once its close time has passed. `asOfMs` is inclusive of a close landing
 * exactly on it (that candle has just completed).
 */
function completedAsOf(candles, asOfMs) {
  if (asOfMs == null) return candles.filter((c) => c.closeMs != null);
  return (candles || []).filter((c) => c.closeMs != null && c.closeMs <= asOfMs);
}

/** Convenience: aggregate then cut to completed-as-of in one call. */
function completedTf(h1Rows, tf, asOfMs) {
  return completedAsOf(aggregateEat(h1Rows, tf), asOfMs);
}

module.exports = { normaliseH1, aggregateEat, completedAsOf, completedTf };
