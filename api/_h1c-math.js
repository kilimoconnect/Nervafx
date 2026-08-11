'use strict';

/**
 * NervaFX H1 Continuation Engine — shared, pure numeric utilities.
 *
 * Every function is deterministic and side-effect free. ATR uses a simple
 * average of true ranges over `period` (the same convention as the existing
 * NervaFX engines' ATR), so results are directly comparable.
 */

/** True iff x is a finite number. */
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Guarded division: returns `fallback` when inputs are invalid or divisor is 0. */
function safeDivide(a, b, fallback = 0) {
  if (!isNum(a) || !isNum(b) || b === 0) return fallback;
  const r = a / b;
  return Number.isFinite(r) ? r : fallback;
}

/** Clamp x into [lo, hi]; non-finite x returns lo. */
function clamp(x, lo, hi) {
  if (!isNum(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/** True range of `cur`. With no previous close, falls back to high-low. */
function trueRange(cur, prevClose) {
  const hl = cur.high - cur.low;
  if (!isNum(prevClose)) return hl;
  return Math.max(hl, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose));
}

/**
 * ATR over `period` as a simple average of the last `period` true ranges.
 * Requires at least period+1 candles (a TR needs a previous close). Returns
 * null when there is not enough history.
 */
function atr(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) trs.push(trueRange(candles[i], candles[i - 1].close));
  const last = trs.slice(-period);
  if (last.length < period) return null;
  let sum = 0;
  for (const t of last) sum += t;
  return sum / period;
}

/** Absolute candle body |close - open|. */
function candleBody(c) { return Math.abs(c.close - c.open); }

/** Candle direction: +1 bullish, -1 bearish, 0 doji. */
function candleDirection(c) { return c.close > c.open ? 1 : c.close < c.open ? -1 : 0; }

/** Close location within the candle range, [0,1] (0 = at low, 1 = at high). Zero-range → 0.5. */
function closeLocation(c) { return safeDivide(c.close - c.low, c.high - c.low, 0.5); }

/**
 * Directional close location in [0,1]: how far the close sits in `dir`.
 * BUY (dir>=0) → toward the high; SELL (dir<0) → toward the low.
 */
function directionalCloseLocation(c, dir) {
  const loc = closeLocation(c);
  return dir >= 0 ? loc : 1 - loc;
}

/** Net signed displacement of a window: last.close - first.open. Empty → 0. */
function netDisplacement(candles) {
  if (!candles || candles.length === 0) return 0;
  return candles[candles.length - 1].close - candles[0].open;
}

/**
 * Directional efficiency in [0,1]: |net close move| / summed absolute
 * close-to-close path. 1 = perfectly efficient trend, 0 = pure chop.
 */
function directionalEfficiency(candles) {
  if (!candles || candles.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < candles.length; i++) path += Math.abs(candles[i].close - candles[i - 1].close);
  const net = Math.abs(candles[candles.length - 1].close - candles[0].close);
  return clamp(safeDivide(net, path, 0), 0, 1);
}

/**
 * Directional body share in [-1,1]: net directional body over total range.
 * >0 means the window's bodies favour `dir`, <0 means they oppose it.
 */
function directionalBodyShare(candles, dir) {
  if (!candles || candles.length === 0) return 0;
  let bodySum = 0, rangeSum = 0;
  for (const c of candles) {
    bodySum += (c.close - c.open);
    rangeSum += (c.high - c.low);
  }
  return clamp(safeDivide(dir * bodySum, rangeSum, 0), -1, 1);
}

/** ATR-normalized distance: distance / atr, with 0 when atr is invalid/zero. */
function atrNormalizedDistance(distance, atrValue) {
  return safeDivide(distance, atrValue, 0);
}

module.exports = {
  isNum,
  safeDivide,
  clamp,
  trueRange,
  atr,
  candleBody,
  candleDirection,
  closeLocation,
  directionalCloseLocation,
  netDisplacement,
  directionalEfficiency,
  directionalBodyShare,
  atrNormalizedDistance,
};
