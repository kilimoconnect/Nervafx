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

// ── Full 28-pair H1 generator (for evaluate/replay integration) ──────────────
// Each currency follows a smooth trend + small oscillation; pair price = V_base/V_quote.
// A clear drift spread (NZD strongest … USD weakest) yields real higher-TF breaks and
// trigger breaks so the signal path is exercised deterministically.
const DRIFT = { USD: -3, EUR: -1, GBP: -0.4, JPY: 0.1, CHF: 0.4, CAD: 1, AUD: 2, NZD: 3 };
const PHASE = { USD: 0.1, EUR: 1.2, GBP: 2.1, JPY: 3.0, CHF: 0.7, CAD: 1.9, AUD: 2.6, NZD: 0.4 };
// Drift separates strong↔weak over the span; the two oscillations (distinct per-currency
// phases/periods) give every pair enough movement to break structure on the higher TFs.
function vAt(ccy, i, N) {
  return Math.exp(
    DRIFT[ccy] * (i / N) * 0.06
    + 0.013 * Math.sin(i / 6 + PHASE[ccy])
    + 0.008 * Math.sin(i / 13 + PHASE[ccy] * 1.7),
  );
}

/** Generate H1 candles for all 28 pairs: N hourly samples → N-1 candles. */
function genH1(N, startMs) {
  const by = {};
  for (const p of PAIRS) by[p] = [];
  for (let i = 0; i < N - 1; i++) {
    const t = startMs + i * HOUR;
    for (const p of PAIRS) {
      const j = p.indexOf('_'), b = p.slice(0, j), q = p.slice(j + 1);
      const o = vAt(b, i, N) / vAt(q, i, N);
      const c = vAt(b, i + 1, N) / vAt(q, i + 1, N);
      const hi = Math.max(o, c) * (1 + 0.0008), lo = Math.min(o, c) * (1 - 0.0008);
      by[p].push({ openMs: t, open: o, high: hi, low: lo, close: c, volume: 100 });
    }
  }
  return by;
}

/** Deep structural clone of an h1ByPair map (so appends don't mutate the original). */
function cloneH1(by) {
  const out = {};
  for (const p of Object.keys(by)) out[p] = by[p].map((r) => ({ ...r }));
  return out;
}

// An EAT day start to anchor generated data on a clean boundary.
const { dayStart } = require('../../research/comparison/periods');
const EAT_DAY0 = dayStart(Date.UTC(2026, 2, 2, 12, 0, 0));

module.exports = { candles, rankDir, RANK_VALUES, HOUR, T0, PAIRS, CURRENCIES, genH1, cloneH1, EAT_DAY0 };
