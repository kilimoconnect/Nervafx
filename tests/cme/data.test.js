'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { filterClosed, validOHLC } = require('../../api/_cme-data');

const H = 3600000;
const T0 = Date.UTC(2026, 7, 13, 0, 0, 0);
const row = (ms, o, h, l, c) => ({ time: new Date(ms).toISOString(), open: o, high: h, low: l, close: c });

test('validOHLC rejects malformed candles', () => {
  assert.equal(validOHLC(1, 1.1, 0.9, 1.05), true);
  assert.equal(validOHLC(1, 0.9, 1.1, 1.0), false); // high < low
  assert.equal(validOHLC(1, 1.02, 0.99, 1.05), false); // high < close
  assert.equal(validOHLC(NaN, 1, 1, 1), false);
});

test('filterClosed excludes the forming candle and sorts/dedupes', () => {
  const rows = [
    row(T0 + 2 * H, 1, 1.1, 0.9, 1.0),
    row(T0 + 0 * H, 1, 1.1, 0.9, 1.0),
    row(T0 + 0 * H, 1, 1.1, 0.9, 1.0), // duplicate
    row(T0 + 3 * H, 1, 1.1, 0.9, 1.0), // forming at evalMs = T0+3H
  ];
  const r = filterClosed(rows, T0 + 3 * H, H);
  assert.equal(r.candles.length, 2);            // 0H, 2H (3H forming excluded, dup dropped)
  assert.equal(r.duplicates, 1);
  assert.equal(r.candles[0].openMs, T0);
  assert.ok(!r.candles.some((c) => c.openMs === T0 + 3 * H));
});

test('filterClosed rejects malformed and counts gaps', () => {
  const rows = [
    row(T0, 1, 1.1, 0.9, 1.0),
    row(T0 + H, 1, 0.8, 1.2, 1.0),   // malformed (high<low)
    row(T0 + 3 * H, 1, 1.1, 0.9, 1.0), // gap after 0H (2H missing)
  ];
  const r = filterClosed(rows, T0 + 10 * H, H);
  assert.equal(r.rejected, 1);
  assert.equal(r.candles.length, 2);
  assert.equal(r.gaps, 1);
});
