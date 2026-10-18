'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { h4, w1, h4Start, weekStart } = require('../../research/paw1h4/aggregate');
const { H1_MS } = require('../../research/paw1h4/config');

// Build H1 candles from a list of closes, starting at a clean H4 boundary.
const H4_BOUNDARY = Date.UTC(2026, 0, 5, 0, 0, 0);   // Mon 2026-01-05 00:00 UTC (also a week start)
function h1series(startMs, n, base) {
  const out = [];
  for (let i = 0; i < n; i++) { const o = base + i; out.push({ openMs: startMs + i * H1_MS, open: o, high: o + 0.5, low: o - 0.5, close: o + 0.1 }); }
  return out;
}

test('weekStart lands on Monday 00:00 UTC', () => {
  const ws = weekStart(Date.UTC(2026, 0, 8, 13, 0, 0)); // Thu
  const d = new Date(ws);
  assert.equal(d.getUTCDay(), 1);        // Monday
  assert.equal(d.getUTCHours(), 0);
  assert.equal(ws, H4_BOUNDARY);
});

test('h4Start buckets to 00/04/08/12/16/20 UTC', () => {
  assert.equal(h4Start(Date.UTC(2026, 0, 5, 5, 59, 0)), Date.UTC(2026, 0, 5, 4, 0, 0));
  assert.equal(h4Start(Date.UTC(2026, 0, 5, 23, 0, 0)), Date.UTC(2026, 0, 5, 20, 0, 0));
});

test('H4 aggregation: OHLC from the real H1, completed-only as-of', () => {
  const h1 = h1series(H4_BOUNDARY, 8, 100);        // exactly 2 full H4 buckets
  const lastClose = H4_BOUNDARY + 8 * H1_MS;
  const bars = h4(h1, lastClose);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].open, 100);                 // first H1 open of bucket
  assert.equal(bars[0].close, 103.1);              // last H1 close of bucket (i=3 → 103.1)
  assert.equal(bars[0].high, 103.5);               // max high
  assert.equal(bars[0].low, 99.5);                 // min low
  assert.equal(bars[0].h1Count, 4);
  assert.equal(bars[0].partial, false);
  // one ms before the 2nd bucket closes → only the first bucket is complete
  assert.equal(h4(h1, bars[1].closeMs - 1).length, 1);
});

test('partial H4 bucket flagged, never fabricated', () => {
  const h1 = h1series(H4_BOUNDARY, 2, 50);          // only 2 of 4 H1 in the bucket
  const bars = h4(h1, H4_BOUNDARY + 4 * H1_MS);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].h1Count, 2);
  assert.equal(bars[0].partial, true);
  assert.equal(bars[0].high, 51.5);                 // real high of the 2 present H1 only (2nd H1 = 51 ± .5)
});

test('W1 aggregation groups a full UTC week into one bucket', () => {
  const h1 = h1series(H4_BOUNDARY, 120, 1);         // 120 H1 across the week
  const asOf = H4_BOUNDARY + 7 * 24 * H1_MS;        // the week has fully elapsed
  const wk = w1(h1, asOf);
  assert.equal(wk.length, 1);
  assert.equal(wk[0].openMs, H4_BOUNDARY);
  assert.equal(wk[0].h1Count, 120);
  assert.equal(wk[0].partial, false);
});
