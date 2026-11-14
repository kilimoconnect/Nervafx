'use strict';

// Shared test fixtures for the Breakout engine.
const { PAIRS, CURRENCIES } = require('../../research/comparison/config');

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * Build an ascending candle array from compact specs. Each spec is {o,h,l,c} (open/high/
 * low/close); openMs/closeMs are auto-assigned on a fixed `step` grid. Missing h/l default
 * to span the open/close so you can write flat or single-value candles tersely.
 */
function candles(specs, step = HOUR, start = T0) {
  return specs.map((s, i) => {
    const o = s.o, c = s.c;
    const high = s.h != null ? s.h : Math.max(o, c);
    const low = s.l != null ? s.l : Math.min(o, c);
    return { openMs: start + i * step, closeMs: start + (i + 1) * step, open: o, high, low, close: c, volume: s.v == null ? null : s.v };
  });
}

/**
 * Build a pair-direction map for all 28 pairs from per-currency scalar "values": a pair is
 * bullish (+1) when base value > quote value, bearish (−1) when base < quote. This is
 * internally consistent (transitive), so the resulting currency scores sum to zero.
 * Pass `omit` (array of pairs) to leave some directions unknown.
 */
function rankDir(values, omit = []) {
  const skip = new Set(omit);
  const pd = {};
  for (const p of PAIRS) {
    if (skip.has(p)) continue;
    const i = p.indexOf('_');
    const b = p.slice(0, i), q = p.slice(i + 1);
    pd[p] = values[b] > values[q] ? 1 : -1;
  }
  return pd;
}

// A strict ranking USD<EUR<GBP<JPY<CHF<CAD<AUD<NZD for sum-to-zero tests.
const RANK_VALUES = { USD: 0, EUR: 1, GBP: 2, JPY: 3, CHF: 4, CAD: 5, AUD: 6, NZD: 7 };

module.exports = { candles, rankDir, RANK_VALUES, HOUR, T0, PAIRS, CURRENCIES };
