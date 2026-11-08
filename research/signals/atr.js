'use strict';

/**
 * Wilder ATR(n) on a series of candles ({open,high,low,close}, ascending), computed
 * through the last candle. True Range = max(high-low, |high-prevClose|, |low-prevClose|).
 * Seed = simple mean of the first n TRs; thereafter ATR = (prevATR*(n-1) + TR)/n.
 * Returns the full ATR array aligned to the candles (null before it is defined) plus the
 * final value. Needs at least n+1 candles.
 */
function wilderATR(candles, n = 14) {
  const out = new Array(candles.length).fill(null);
  if (!candles || candles.length < n + 1) return { atr: out, last: null };
  const tr = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // Seed ATR at index n = mean of TR[1..n]
  let sum = 0; for (let i = 1; i <= n; i++) sum += tr[i];
  out[n] = sum / n;
  for (let i = n + 1; i < candles.length; i++) out[i] = (out[i - 1] * (n - 1) + tr[i]) / n;
  return { atr: out, last: out[candles.length - 1] };
}

/** ATR value as of candle at index i (inclusive), or null if undefined there. */
function atrAt(candles, n, i) {
  const { atr } = wilderATR(candles.slice(0, i + 1), n);
  return atr.length ? atr[atr.length - 1] : null;
}

module.exports = { wilderATR, atrAt };
