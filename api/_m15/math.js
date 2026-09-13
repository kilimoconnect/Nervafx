'use strict';

/**
 * M15 Intelligence — deterministic numeric primitives shared by every engine.
 * Pure functions only; no I/O, no Date.now(), no randomness. Given the same
 * inputs they always return the same output (§34, reproducibility §27).
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
}

/** True range of candle c given the previous candle p (p may be null). */
function trueRange(c, p) {
  const hl = c.high - c.low;
  if (!p) return hl;
  return Math.max(hl, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
}

/** EWMA smoothing factor from a half-life expressed in samples. */
function alphaFromHalfLife(halfLifeCandles) {
  return 1 - Math.pow(0.5, 1 / Math.max(1e-9, halfLifeCandles));
}

/**
 * Exponentially-weighted moving average series over `values`, seeded with the
 * first value. Returns an array the same length as the input. This is an
 * *adaptive baseline* (it forgets old data smoothly); it is NOT a fixed window.
 */
function ewmaSeries(values, halfLifeCandles) {
  const a = alphaFromHalfLife(halfLifeCandles);
  const out = [];
  let prev = null;
  for (const v of values) {
    prev = prev === null ? v : prev + a * (v - prev);
    out.push(prev);
  }
  return out;
}

/** Standard EMA (period-based) — used only for the explicit EMA20/EMA50 (§17). */
function emaSeries(values, period) {
  const a = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (const v of values) {
    prev = prev === null ? v : prev + a * (v - prev);
    out.push(prev);
  }
  return out;
}

/** Adaptive true-range volatility series (EWMA of TR). */
function volatilitySeries(candles, halfLifeCandles) {
  const tr = candles.map((c, i) => trueRange(c, i > 0 ? candles[i - 1] : null));
  return ewmaSeries(tr, halfLifeCandles);
}

/** Squash any real number to (−1, 1) — smooth, monotonic, deterministic. */
function tanhNorm(x) { return Math.tanh(x); }

/** Map a 0..1 quality to 0..100. */
const pct = (x) => clamp(x, 0, 1) * 100;

/** Linear ramp: 0 at `a`, 1 at `b` (a may be > b for a falling ramp). */
function ramp(x, a, b) {
  if (a === b) return x >= a ? 1 : 0;
  return clamp((x - a) / (b - a), 0, 1);
}

module.exports = {
  clamp, sign, mean, std, trueRange, alphaFromHalfLife, ewmaSeries, emaSeries,
  volatilitySeries, tanhNorm, pct, ramp,
};
