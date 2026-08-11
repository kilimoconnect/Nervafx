'use strict';

// NervaFX H1 Continuation Engine — pullback lifecycle tests.
// Run with:  node --test tests/h1c

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePullback } = require('../../api/_h1c-pullback');
const { STATES, INVALIDATION, OUTCOME } = require('../../api/_h1c-constants');

const START = Date.UTC(2026, 0, 1);
const HOUR = 3600000;

// Sequential hourly candles from [open,high,low,close] rows.
function mk(rows) {
  return rows.map((r, i) => ({
    time: new Date(START + i * HOUR).toISOString(), ms: START + i * HOUR,
    open: r[0], high: r[1], low: r[2], close: r[3],
  }));
}
// Candles with explicit hour offsets (for gap testing).
function mkH(rows) {
  return rows.map((r) => ({
    time: new Date(START + r[0] * HOUR).toISOString(), ms: START + r[0] * HOUR,
    open: r[1], high: r[2], low: r[3], close: r[4],
  }));
}
function flats(n) { return Array.from({ length: n }, () => [1.0000, 1.0002, 0.9998, 1.0000]); }

// Reference BUY impulse over candles 0..2 (endPrice 1.0030, high 1.0030, low 1.0000).
const IMP = [[1.0000, 1.0010, 1.0000, 1.0010], [1.0010, 1.0020, 1.0010, 1.0020], [1.0020, 1.0030, 1.0020, 1.0030]];
function refBUY(over = {}) {
  return Object.assign({
    direction: 1, endIdx: 2, endPrice: 1.0030, high: 1.0030, low: 1.0000,
    netMove: 0.0030, candleCount: 3, atr: 0.0005,
    startIdx: 0, startPrice: 1.0000,
    startTime: new Date(START).toISOString(), endTime: new Date(START + 2 * HOUR).toISOString(),
  }, over);
}
// A gentle downward pullback of `n` candles starting from 1.0030 (−0.0002/candle).
function slope(n) {
  const rows = []; let px = 1.0030;
  for (let i = 0; i < n; i++) { const c = px - 0.0002; rows.push([px, px, c - 0.0001, c]); px = c; }
  return rows;
}

test('exactly six pullback candles = PULLBACK_VALID', () => {
  const r = analyzePullback(mk([...IMP, ...slope(6)]), { reference: refBUY() });
  assert.equal(r.state, STATES.PULLBACK_VALID);
  assert.equal(r.count, 6);
});

test('exactly twelve pullback candles = PULLBACK_VALID', () => {
  const r = analyzePullback(mk([...IMP, ...slope(12)]), { reference: refBUY() });
  assert.equal(r.state, STATES.PULLBACK_VALID);
  assert.equal(r.count, 12);
});

test('five pullback candles = PULLBACK_FORMING', () => {
  const r = analyzePullback(mk([...IMP, ...slope(5)]), { reference: refBUY() });
  assert.equal(r.state, STATES.PULLBACK_FORMING);
  assert.equal(r.count, 5);
});

test('thirteen pullback candles = EXPIRED', () => {
  const r = analyzePullback(mk([...IMP, ...slope(13)]), { reference: refBUY() });
  assert.equal(r.state, STATES.EXPIRED);
  assert.equal(r.count, 13);
});

test('sideways compression accepted (high overlap)', () => {
  const box = [
    [1.0030, 1.0030, 1.0025, 1.0026],   // gentle entry (avoids the speed guard)
    [1.0026, 1.0028, 1.0022, 1.0024],
    [1.0024, 1.0028, 1.0022, 1.0026],
    [1.0026, 1.0028, 1.0022, 1.0024],
    [1.0024, 1.0028, 1.0022, 1.0026],
    [1.0026, 1.0028, 1.0022, 1.0024],
  ];
  const r = analyzePullback(mk([...IMP, ...box]), { reference: refBUY() });
  assert.equal(r.state, STATES.PULLBACK_VALID);
  assert.ok(r.overlap > 0.5, `overlap ${r.overlap}`);
});

test('sloped correction accepted (high efficiency)', () => {
  const r = analyzePullback(mk([...IMP, ...slope(6)]), { reference: refBUY() });
  assert.equal(r.state, STATES.PULLBACK_VALID);
  assert.ok(r.efficiency > 0.8, `efficiency ${r.efficiency}`);
});

test('wick through the reference level with a valid close does not invalidate', () => {
  const pb = [
    [1.0030, 1.0030, 1.0027, 1.0028],
    [1.0028, 1.0028, 0.9995, 1.0026],   // wick to 0.9995 but closes 1.0026 (> low 1.0000)
    [1.0026, 1.0026, 1.0023, 1.0024],
    [1.0024, 1.0024, 1.0021, 1.0022],
    [1.0022, 1.0022, 1.0019, 1.0020],
    [1.0020, 1.0020, 1.0017, 1.0018],
  ];
  const r = analyzePullback(mk([...IMP, ...pb]), { reference: refBUY() });
  assert.notEqual(r.state, STATES.INVALIDATED);
  assert.equal(r.state, STATES.PULLBACK_VALID);
});

test('closed-candle structural invalidation (close below reference low)', () => {
  const pb = [
    [1.0030, 1.0030, 1.0027, 1.0028],
    [1.0028, 1.0028, 0.9990, 0.9995],   // CLOSE below 1.0000
  ];
  const r = analyzePullback(mk([...IMP, ...pb]), { reference: refBUY() });
  assert.equal(r.state, STATES.INVALIDATED);
  assert.equal(r.invalidation, INVALIDATION.STRUCTURE_BREAK);
});

test('early continuation before candle six', () => {
  const pb = [
    [1.0030, 1.0032, 1.0028, 1.0029],
    [1.0029, 1.0040, 1.0029, 1.0038],   // closes 1.0038 > extreme 1.0030 at count 2
  ];
  const r = analyzePullback(mk([...IMP, ...pb]), { reference: refBUY() });
  assert.equal(r.outcome, OUTCOME.EARLY_CONTINUATION);
});

test('opposite impulse invalidates the candidate (provisional window)', () => {
  const candles = mk([
    ...flats(23),
    [1.0000, 1.0030, 1.0000, 1.0030],               // BUY impulse (ends idx 24)
    [1.0030, 1.0060, 1.0030, 1.0060],
    [1.0060, 1.0060, 1.0037, 1.0037],               // SELL impulse (ends idx 27)
    [1.0037, 1.0037, 1.0014, 1.0014],
    [1.0014, 1.0014, 0.9991, 0.9991],
  ]);
  const reference = {
    direction: 1, endIdx: 24, endPrice: 1.0060, high: 1.0060, low: 0.9500,   // deep low: no structural break first
    netMove: 0.0060, candleCount: 2, atr: 0.0007, endTime: candles[24].time,
  };
  const r = analyzePullback(candles, { reference });
  assert.equal(r.state, STATES.INVALIDATED);
  assert.equal(r.invalidation, INVALIDATION.OPPOSITE_IMPULSE);
});

test('the latest same-direction impulse (Impulse 2) is used as the reference', () => {
  const candles = mk([
    ...flats(22),
    [1.0000, 1.0010, 1.0000, 1.0010],               // Impulse 1
    [1.0010, 1.0020, 1.0010, 1.0020],
    [1.0020, 1.0030, 1.0020, 1.0030],
    [1.0030, 1.0032, 1.0028, 1.0030],               // pause
    [1.0030, 1.0032, 1.0028, 1.0030],
    [1.0030, 1.0032, 1.0028, 1.0030],
    [1.0030, 1.0040, 1.0030, 1.0040],               // Impulse 2 (latest)
    [1.0040, 1.0050, 1.0040, 1.0050],
    [1.0050, 1.0060, 1.0050, 1.0060],
    [1.0060, 1.0060, 1.0057, 1.0058],               // pullback after Impulse 2
    [1.0058, 1.0058, 1.0055, 1.0056],
    [1.0056, 1.0056, 1.0053, 1.0054],
  ]);
  const r = analyzePullback(candles);                // no explicit reference → detect latest
  assert.ok(r.reference, 'a reference should be detected');
  assert.equal(r.reference.direction, 1);
  assert.ok(r.reference.endIdx >= 28, `reference should be Impulse 2, got endIdx ${r.reference.endIdx}`);
  assert.ok(r.reference.previousAlignedImpulseCount >= 1, 'Impulse 1 kept as context');
});

test('missing H1 candle inside the pullback resets the count', () => {
  const candles = mkH([
    [0, ...IMP[0]], [1, ...IMP[1]], [2, ...IMP[2]],
    [3, 1.0030, 1.0030, 1.0025, 1.0026],            // pullback count 1
    [4, 1.0026, 1.0026, 1.0023, 1.0024],            // count 2
    [10, 1.0024, 1.0024, 1.0021, 1.0022],           // gap (6h) -> reset to count 1
    [11, 1.0022, 1.0022, 1.0019, 1.0020],           // count 2
    [12, 1.0020, 1.0020, 1.0017, 1.0018],           // count 3
  ]);
  const r = analyzePullback(candles, { reference: refBUY() });
  assert.equal(r.gaps, 1);
  assert.equal(r.count, 3);                           // count restarted after the gap
});
