'use strict';

/**
 * NervaFX Liquidity Failure Engine — deterministic price math.
 *
 * All feature magnitudes are normalised through H1 ATR so JPY and non-JPY pairs
 * run through identical logic. Pure functions only; no I/O, no clock reads.
 */

const { CONFIG } = require('./_lfe-constants');

/** Pip size for the denominator guard (JPY-quoted = 0.01, else 0.0001). */
function pipSizeFor(pair) {
  return /JPY/.test(String(pair || '').toUpperCase().split('_')[1] || '') ? 0.01 : 0.0001;
}

function trueRange(cur, prev) {
  const hl = cur.high - cur.low;
  if (!prev) return hl;
  return Math.max(hl, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
}

/**
 * Rolling simple ATR over `period` candles. atr[i] = mean(TR[i-period+1..i]),
 * null before enough history. No lookahead — atr[i] uses only candles ≤ i.
 */
function atrSeries(candles, period) {
  period = period || CONFIG.atr.h1Period;
  const tr = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) tr[i] = trueRange(candles[i], i ? candles[i - 1] : null);
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Newest non-null ATR value (the "current" H1 ATR). */
function atrNowOf(atr) {
  for (let i = atr.length - 1; i >= 0; i--) if (atr[i] != null) return atr[i];
  return null;
}

/**
 * Per-candle features, ATR-normalised. Returns null magnitudes when ATR is
 * unavailable rather than dividing by zero.
 */
function candleFeatures(candle, atr, pipSize) {
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const denom = Math.max(range, pipSize);
  return {
    range,
    body,
    bodyATR: atr ? body / atr : null,
    rangeATR: atr ? range / atr : null,
    closeLocation: (candle.close - candle.low) / denom,
  };
}

/** zoneWidth = max(0.05 × H1_ATR, 2 × currentSpread). Spread defaults to 0 (OHLC-only data). */
function zoneWidth(atrNow, spread) {
  return Math.max(CONFIG.zone.atrMultiplier * atrNow, 2 * (spread || 0));
}

/** New candidates are rejected when the zone exceeds 0.15 × H1 ATR. */
function zoneWidthOK(zw, atrNow) {
  return zw <= CONFIG.zone.maxWidthAtr * atrNow;
}

function mean(nums) {
  if (!nums.length) return null;
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Standard EMA series (seeded on the first value). Lookahead-free. */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

module.exports = {
  pipSizeFor, trueRange, atrSeries, atrNowOf, candleFeatures, zoneWidth, zoneWidthOK, mean, clamp, emaSeries,
};
