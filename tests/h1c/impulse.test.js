'use strict';

// NervaFX H1 Continuation Engine — reference-impulse detector tests.
// Run with:  node --test tests/h1c

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateWindow, selectReference, detectReferenceImpulse } = require('../../api/_h1c-impulse');

const START = Date.UTC(2026, 0, 1);
const HOUR = 3600000;

// Build candles from [open,high,low,close] rows with sequential hourly times.
function mk(rows) {
  return rows.map((r, i) => ({
    time: new Date(START + i * HOUR).toISOString(),
    ms: START + i * HOUR,
    open: r[0], high: r[1], low: r[2], close: r[3],
  }));
}
const FLAT = [1.0000, 1.0002, 0.9998, 1.0000];
function flats(n, row = FLAT) { return Array.from({ length: n }, () => row.slice()); }

const ATRV = 0.0005;  // explicit ATR for evaluateWindow tests

// 5-candle structure base + a window, so window start index s = 5.
function withStructure(windowRows, structRows = flats(5)) {
  return mk([...structRows, ...windowRows]);
}

test('bullish impulse qualifies with full quality', () => {
  const candles = withStructure([
    [1.0000, 1.0010, 1.0000, 1.0010],
    [1.0010, 1.0020, 1.0010, 1.0020],
    [1.0020, 1.0030, 1.0020, 1.0030],
  ]);
  const r = evaluateWindow(candles, 5, 7, ATRV);
  assert.ok(r, 'should qualify');
  assert.equal(r.direction, 1);
  assert.equal(r.candleCount, 3);
  assert.equal(r.extensionCandles, 3);
  assert.equal(r.quality, 100);
  assert.equal(r.structureLevel, 1.0002);
  assert.ok(Math.abs(r.efficiency - 1) < 1e-9);
});

test('bearish impulse qualifies', () => {
  const candles = withStructure([
    [1.0000, 1.0000, 0.9990, 0.9990],
    [0.9990, 0.9990, 0.9980, 0.9980],
    [0.9980, 0.9980, 0.9970, 0.9970],
  ]);
  const r = evaluateWindow(candles, 5, 7, ATRV);
  assert.ok(r, 'should qualify');
  assert.equal(r.direction, -1);
  assert.equal(r.extensionCandles, 3);
  assert.equal(r.quality, 100);
  assert.equal(r.structureLevel, 0.9998);
});

test('weak movement (< 1.20 ATR) is rejected', () => {
  const candles = withStructure([
    [1.0000, 1.0002, 1.0000, 1.0002],
    [1.0002, 1.0004, 1.0002, 1.0004],
  ]);
  assert.equal(evaluateWindow(candles, 5, 6, ATRV), null);
});

test('no structure break is rejected (prior wick above the close)', () => {
  const struct = flats(5);
  struct[2] = [1.0000, 1.0035, 0.9998, 1.0000];   // tall prior wick high
  const candles = withStructure([
    [1.0000, 1.0010, 1.0000, 1.0010],
    [1.0010, 1.0020, 1.0010, 1.0020],
    [1.0020, 1.0030, 1.0020, 1.0030],
  ], struct);
  assert.equal(evaluateWindow(candles, 5, 7, ATRV), null);
});

test('two consecutive counter candles are rejected (no merge)', () => {
  const candles = withStructure([
    [1.0000, 1.0010, 1.0000, 1.0010],
    [1.0010, 1.0020, 1.0010, 1.0020],
    [1.0020, 1.0020, 1.0013, 1.0014],   // counter
    [1.0014, 1.0014, 1.0007, 1.0008],   // counter (consecutive)
    [1.0008, 1.0025, 1.0008, 1.0023],
  ]);
  assert.equal(evaluateWindow(candles, 5, 9, ATRV), null);
});

test('internal counter-move >= 0.50 ATR is rejected (no merge)', () => {
  const candles = withStructure([
    [1.0000, 1.0010, 1.0000, 1.0010],
    [1.0010, 1.0022, 1.0007, 1.0020],   // low dips 0.0003 below prior peak (>= 0.5*ATR=0.00025)
    [1.0020, 1.0032, 1.0020, 1.0030],
  ]);
  assert.equal(evaluateWindow(candles, 5, 7, ATRV), null);
});

test('selection: most-recent end wins, then quality, then shorter window', () => {
  // most recent end
  assert.equal(selectReference([
    { endIdx: 10, quality: 90, startIdx: 8 },
    { endIdx: 12, quality: 50, startIdx: 10 },
  ]).endIdx, 12);
  // same end -> higher quality
  assert.equal(selectReference([
    { endIdx: 10, quality: 70, startIdx: 9 },
    { endIdx: 10, quality: 85, startIdx: 7 },
  ]).startIdx, 7);
  // same end, same quality -> shorter window (larger startIdx = smaller span)
  assert.equal(selectReference([
    { endIdx: 10, quality: 80, startIdx: 8 },
    { endIdx: 10, quality: 80, startIdx: 9 },
  ]).startIdx, 9);
});

test('two separate impulses: the LATEST is selected, earlier counted as context', () => {
  const candles = mk([
    ...flats(22),                                   // ATR warm-up
    [1.0000, 1.0010, 1.0000, 1.0010],               // impulse 1
    [1.0010, 1.0020, 1.0010, 1.0020],
    [1.0020, 1.0030, 1.0020, 1.0030],
    [1.0030, 1.0032, 1.0028, 1.0030],               // pause
    [1.0030, 1.0032, 1.0028, 1.0030],
    [1.0030, 1.0032, 1.0028, 1.0030],
    [1.0030, 1.0040, 1.0030, 1.0040],               // impulse 2 (latest)
    [1.0040, 1.0050, 1.0040, 1.0050],
    [1.0050, 1.0060, 1.0050, 1.0060],
  ]);
  const ref = detectReferenceImpulse(candles);
  assert.ok(ref, 'an impulse should be found');
  assert.equal(ref.endIdx, candles.length - 1);     // impulse 2 ends at the last candle
  assert.equal(ref.direction, 1);
  assert.ok(ref.previousAlignedImpulseCount >= 1, 'impulse 1 recorded as context');
});

test('no lookahead: appending future candles does not change a past evaluation', () => {
  const base = mk([
    ...flats(30),
    [1.0000, 1.0010, 1.0000, 1.0010],
    [1.0010, 1.0020, 1.0010, 1.0020],
    [1.0020, 1.0030, 1.0020, 1.0030],
  ]);
  const k = base.length - 1;
  const withFuture = mk([
    ...base.map((c) => [c.open, c.high, c.low, c.close]),
    [1.0030, 1.0045, 1.0030, 1.0045],               // future impulse candle
    [1.0045, 1.0060, 1.0045, 1.0060],
    [1.0060, 1.0075, 1.0060, 1.0075],
  ]);
  const a = detectReferenceImpulse(base, { searchEndIdx: k });
  const b = detectReferenceImpulse(withFuture, { searchEndIdx: k });
  assert.ok(a && b);
  assert.equal(a.endIdx, b.endIdx);
  assert.equal(a.quality, b.quality);
});

test('current-candle exclusion: searchEndIdx never returns an impulse ending past it', () => {
  const candles = mk([
    ...flats(25),
    [1.0000, 1.0010, 1.0000, 1.0010],
    [1.0010, 1.0020, 1.0010, 1.0020],
    [1.0020, 1.0030, 1.0020, 1.0030],               // impulse ends at last index
  ]);
  const n = candles.length;
  const full = detectReferenceImpulse(candles);
  assert.equal(full.endIdx, n - 1);
  const excluded = detectReferenceImpulse(candles, { searchEndIdx: n - 2 });
  assert.ok(excluded === null || excluded.endIdx <= n - 2, 'forming candle excluded');
});
