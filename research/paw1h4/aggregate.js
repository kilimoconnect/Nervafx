'use strict';

/**
 * Aggregate stored H1 candles into completed H4 and W1 candles, UTC-anchored and
 * DST-invariant (see config.js for the boundary contract). We NEVER fabricate a
 * missing sub-candle: a bucket is built only from the real H1 candles that fall in
 * it, and a bucket is emitted only once it is fully COMPLETE as-of the evaluation
 * time. Coverage is recorded so the UI/backtest can flag or exclude thin buckets.
 */

const { H1_MS, H4_MS, DAY_MS, WEEK_MS } = require('./config');

/** Start of the H4 bucket (00,04,08,12,16,20 UTC) containing ms. */
function h4Start(ms) { return Math.floor(ms / H4_MS) * H4_MS; }

/** Start of the UTC week (Monday 00:00 UTC) containing ms. */
function weekStart(ms) {
  const dayMidnight = Math.floor(ms / DAY_MS) * DAY_MS;     // exact UTC midnight (epoch is UTC)
  const dow = new Date(dayMidnight).getUTCDay();            // 0=Sun … 6=Sat
  const daysSinceMon = (dow + 6) % 7;                       // Mon=0 … Sun=6
  return dayMidnight - daysSinceMon * DAY_MS;
}

/** Normalize a stored/raw candle to { openMs, open, high, low, close }. */
function normH1(c) {
  const openMs = c.openMs != null ? c.openMs : (c.time != null ? Date.parse(c.time) : null);
  return { openMs, open: +c.open, high: +c.high, low: +c.low, close: +c.close };
}

/**
 * Generic aggregator.
 * @param h1          chronological H1 candles (any object with time/openMs + OHLC)
 * @param startFn     ms → bucket start
 * @param spanMs      bucket length (H4_MS or WEEK_MS)
 * @param nominalH1   reference H1 count for coverage % (4 for H4, ~120 for W1)
 * @param asOfMs      only buckets whose end ≤ asOfMs are COMPLETE and returned
 * @returns completed buckets, chronological:
 *   { openMs, closeMs, open, high, low, close, h1Count, nominalH1, coveragePct,
 *     partial, complete:true }
 */
function aggregate(h1, startFn, spanMs, nominalH1, asOfMs) {
  const byBucket = new Map();
  for (const raw of h1) {
    const c = normH1(raw);
    if (c.openMs == null || !isFinite(c.open)) continue;
    const bs = startFn(c.openMs);
    let b = byBucket.get(bs);
    if (!b) { b = { openMs: bs, closeMs: bs + spanMs, open: c.open, high: c.high, low: c.low, close: c.close, h1Count: 0, firstMs: c.openMs, lastMs: c.openMs }; byBucket.set(bs, b); }
    if (c.openMs < b.firstMs) { b.firstMs = c.openMs; b.open = c.open; }
    if (c.openMs > b.lastMs) { b.lastMs = c.openMs; b.close = c.close; }
    if (c.high > b.high) b.high = c.high;
    if (c.low < b.low) b.low = c.low;
    b.h1Count += 1;
  }
  const out = [];
  for (const b of [...byBucket.values()].sort((a, z) => a.openMs - z.openMs)) {
    if (asOfMs != null && b.closeMs > asOfMs) continue;      // bucket not fully elapsed → not complete
    out.push({
      openMs: b.openMs, closeMs: b.closeMs,
      open: +b.open, high: +b.high, low: +b.low, close: +b.close,
      h1Count: b.h1Count, nominalH1,
      coveragePct: Math.round((b.h1Count / nominalH1) * 100),
      partial: b.h1Count < nominalH1,
      complete: true,
    });
  }
  return out;
}

/** Completed H4 candles as-of asOfMs (nominal 4 H1 per bucket). */
function h4(h1, asOfMs) { return aggregate(h1, h4Start, H4_MS, 4, asOfMs); }

/** Completed W1 candles as-of asOfMs (nominal ~120 trading H1 per week). */
function w1(h1, asOfMs) { return aggregate(h1, weekStart, WEEK_MS, 120, asOfMs); }

module.exports = { h4Start, weekStart, aggregate, h4, w1, H4_MS, WEEK_MS };
