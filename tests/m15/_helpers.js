'use strict';
const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2025, 5, 2, 0, 0, 0); // a Monday

/** Build an M15 candle by open index. */
function mk(i, o, h, l, c) {
  const openMs = T0 + i * M15;
  return { openMs, time: new Date(openMs).toISOString(), open: o, high: h, low: l, close: c, volume: 1000, complete: true };
}

/** Flat/dead series: n candles hovering around `base` with tiny jitter. */
function flat(n, base = 1.1000, jitter = 0.00002) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = base + (i % 2 ? jitter : -jitter);
    out.push(mk(i, base, base + jitter, base - jitter, c));
  }
  return out;
}

/** Clean zigzag with amplitude `amp` and half-period `half` candles. */
function zigzag(n, base = 1.1000, amp = 0.0040, half = 10) {
  const out = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const phase = Math.floor(i / half) % 2 === 0 ? 1 : -1;
    const step = (amp / half) * phase;
    const open = price;
    price += step;
    const hi = Math.max(open, price) + amp * 0.05;
    const lo = Math.min(open, price) - amp * 0.05;
    out.push(mk(i, open, hi, lo, price));
  }
  return out;
}

/** Scale every price range around its open by factor k (raises volatility k×). */
function scaleVol(candles, k) {
  return candles.map((c) => ({
    ...c,
    high: c.open + (c.high - c.open) * k,
    low: c.open - (c.open - c.low) * k,
    close: c.open + (c.close - c.open) * k,
  }));
}

module.exports = { M15, T0, mk, flat, zigzag, scaleVol };
