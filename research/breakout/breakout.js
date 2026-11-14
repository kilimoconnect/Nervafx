'use strict';

/**
 * Break of structure (exact definition, spec §3). For a completed candle t:
 *   bullish break : Close[t] >  High[t-1]
 *   bearish break : Close[t] <  Low[t-1]
 *   otherwise     : no qualifying break
 *
 * Rules enforced here:
 *   - Compare against the PREVIOUS candle's high/low, not its close.
 *   - A close exactly ON the boundary does NOT qualify (strict > / <).
 *   - A wick crossing a boundary does NOT qualify without a close beyond it
 *     (we only ever look at Close[t]).
 *   - Completed, actual, unsmoothed OHLC only (no swing/pivot/fractal/indicator logic).
 *
 * The same definition applies on every timeframe.
 */

function isBullishBreak(c, prev) { return c.close > prev.high; }
function isBearishBreak(c, prev) { return c.close < prev.low; }

/** Classify one completed candle `c` against its immediate predecessor `prev`. */
function classifyBreak(c, prev) {
  if (c.close > prev.high) return { direction: 1, boundary: 'high', level: prev.high };
  if (c.close < prev.low) return { direction: -1, boundary: 'low', level: prev.low };
  return { direction: 0, boundary: null, level: null };
}

function breakDetail(dir, c, prev, idx, n) {
  return {
    direction: dir,                                  // +1 bullish | -1 bearish
    brokenBoundary: dir > 0 ? 'high' : 'low',
    brokenLevel: dir > 0 ? prev.high : prev.low,
    breakIdx: idx,
    breakOpenMs: c.openMs,
    breakCloseMs: c.closeMs,
    breakOhlc: { open: c.open, high: c.high, low: c.low, close: c.close },
    prevHigh: prev.high,
    prevLow: prev.low,
    ageCandles: (n - 1) - idx,                       // completed candles since the break candle
    lastEvaluatedMs: n ? null : null,                // filled by caller from the last candle
  };
}

/**
 * The pair's current direction = the MOST RECENT qualifying break in the available
 * (completed) history. Scans backward from the latest completed candle. There is NO age
 * limit and NO expiry: the latest break may be one candle ago or many. Returns:
 *   { direction: +1|-1, ...breakDetail, lastEvaluatedMs }  — a break was found
 *   { direction: 0, reason: 'insufficient-history' }       — < 2 completed candles
 *   { direction: 0, reason: 'no-break-in-history' }        — no qualifying break anywhere
 *
 * `candles` must be ascending, completed candles (already cut to the evaluation cutoff).
 */
function latestBreak(candles) {
  const n = (candles || []).length;
  if (n < 2) return { direction: 0, reason: 'insufficient-history', evaluated: n, lastEvaluatedMs: n ? candles[n - 1].closeMs : null };
  const lastEvaluatedMs = candles[n - 1].closeMs;
  for (let i = n - 1; i >= 1; i--) {
    const cls = classifyBreak(candles[i], candles[i - 1]);
    if (cls.direction !== 0) {
      const d = breakDetail(cls.direction, candles[i], candles[i - 1], i, n);
      d.lastEvaluatedMs = lastEvaluatedMs;
      return d;
    }
  }
  return { direction: 0, reason: 'no-break-in-history', evaluated: n, lastEvaluatedMs };
}

module.exports = { isBullishBreak, isBearishBreak, classifyBreak, latestBreak };
