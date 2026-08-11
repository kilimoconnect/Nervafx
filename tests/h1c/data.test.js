'use strict';

// NervaFX H1 Continuation Engine — closed-candle enforcement tests.
// Run with:  node --test tests/h1c

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeH1 } = require('../../api/_h1c-data');
const { HOUR_MS, DATA_REJECTIONS } = require('../../api/_h1c-constants');

function mkRows(n, startMs) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ms = startMs + i * HOUR_MS;
    rows.push({ time: new Date(ms).toISOString(), open: 1, high: 2, low: 0, close: 1 });
  }
  return rows;
}

test('excludes the forming candle (close time > evalMs)', () => {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);       // opens 00:00, 01:00, 02:00
  const rows = mkRows(3, start);
  const evalMs = start + 2 * HOUR_MS;                 // 02:00
  // 00:00 closes 01:00 (keep), 01:00 closes 02:00 (keep), 02:00 closes 03:00 (drop).
  const r = sanitizeH1(rows, evalMs, { minCandles: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.candles.length, 2);
  assert.equal(r.candles[r.candles.length - 1].ms, start + HOUR_MS);
});

test('preserves original timestamps and numeric coercion', () => {
  const start = Date.UTC(2026, 0, 1);
  const rows = mkRows(2, start);
  rows[0].open = '1.5';                               // stringy provider value
  const r = sanitizeH1(rows, start + 5 * HOUR_MS, { minCandles: 1 });
  assert.equal(r.candles[0].time, rows[0].time);      // timestamp preserved verbatim
  assert.equal(r.candles[0].open, 1.5);               // coerced to number
});

test('detects duplicate candles as a hard rejection', () => {
  const start = Date.UTC(2026, 0, 1);
  const rows = mkRows(3, start);
  rows.push({ ...rows[1] });                          // duplicate open time
  const r = sanitizeH1(rows, start + 10 * HOUR_MS, { minCandles: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DATA_REJECTIONS.DUPLICATE_CANDLE);
});

test('flags insufficient history against the minimum', () => {
  const start = Date.UTC(2026, 0, 1);
  const rows = mkRows(3, start);
  const r = sanitizeH1(rows, start + 10 * HOUR_MS, { minCandles: 150 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DATA_REJECTIONS.INSUFFICIENT_HISTORY);
});

test('counts gaps but does not reject on them', () => {
  const start = Date.UTC(2026, 0, 1);
  const rows = mkRows(3, start);                       // 00:00,01:00,02:00
  rows.push({ time: new Date(start + 8 * HOUR_MS).toISOString(), open: 1, high: 2, low: 0, close: 1 });
  const r = sanitizeH1(rows, start + 100 * HOUR_MS, { minCandles: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.meta.gaps, 1);                        // one break in the sequence
  assert.equal(r.candles.length, 4);
});

test('unsorted input is returned ascending', () => {
  const start = Date.UTC(2026, 0, 1);
  const rows = mkRows(4, start).reverse();            // provider desc order
  const r = sanitizeH1(rows, start + 100 * HOUR_MS, { minCandles: 1 });
  for (let i = 1; i < r.candles.length; i++) {
    assert.ok(r.candles[i].ms > r.candles[i - 1].ms);
  }
});

test('empty input returns NO_DATA', () => {
  const r = sanitizeH1([], Date.now(), { minCandles: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DATA_REJECTIONS.NO_DATA);
});
