'use strict';

// NervaFX H1 Continuation Engine — foundation math tests.
// Zero dependencies: Node's built-in test runner + assert.  Run with:
//   node --test tests/h1c

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../../api/_h1c-math');

test('safeDivide guards zero and non-finite', () => {
  assert.equal(m.safeDivide(10, 2), 5);
  assert.equal(m.safeDivide(10, 0), 0);
  assert.equal(m.safeDivide(10, 0, -1), -1);
  assert.equal(m.safeDivide(Infinity, 2, 0), 0);
  assert.equal(m.safeDivide('x', 2, 0), 0);
});

test('clamp', () => {
  assert.equal(m.clamp(5, 0, 10), 5);
  assert.equal(m.clamp(-1, 0, 10), 0);
  assert.equal(m.clamp(99, 0, 10), 10);
  assert.equal(m.clamp(NaN, 0, 10), 0);
});

test('trueRange with and without a previous close', () => {
  const cur = { high: 12, low: 8, open: 9, close: 11 };
  assert.equal(m.trueRange(cur, undefined), 4);        // high - low
  assert.equal(m.trueRange(cur, 5), 7);                // |high - prevClose| = 7 wins
  assert.equal(m.trueRange(cur, 13), 5);               // |low - prevClose| = 5 wins
});

test('atr(20) = simple average of true ranges; null when short', () => {
  const candles = [];
  let px = 100;
  for (let i = 0; i < 22; i++) candles.push({ open: px, high: px + 1, low: px - 1, close: px });
  assert.equal(m.atr(candles, 20), 2);                 // every TR = 2
  assert.equal(m.atr(candles.slice(0, 5), 20), null);  // fewer than period+1
});

test('candleBody / candleDirection', () => {
  assert.equal(m.candleBody({ open: 10, close: 13 }), 3);
  assert.equal(m.candleBody({ open: 13, close: 10 }), 3);
  assert.equal(m.candleDirection({ open: 10, close: 13 }), 1);
  assert.equal(m.candleDirection({ open: 13, close: 10 }), -1);
  assert.equal(m.candleDirection({ open: 10, close: 10 }), 0);
});

test('closeLocation / directionalCloseLocation', () => {
  const c = { open: 10, high: 12, low: 8, close: 11 };
  assert.equal(m.closeLocation(c), 0.75);
  assert.equal(m.directionalCloseLocation(c, 1), 0.75);
  assert.equal(m.directionalCloseLocation(c, -1), 0.25);
  assert.equal(m.closeLocation({ open: 5, high: 5, low: 5, close: 5 }), 0.5); // zero range
});

test('netDisplacement', () => {
  const w = [{ open: 10, close: 11 }, { open: 11, close: 12 }, { open: 12, close: 14 }];
  assert.equal(m.netDisplacement(w), 4);
  assert.equal(m.netDisplacement([]), 0);
});

test('directionalEfficiency: 1 for a straight leg, 1/3 for chop', () => {
  const straight = [{ close: 10 }, { close: 11 }, { close: 12 }, { close: 13 }];
  assert.equal(m.directionalEfficiency(straight), 1);
  const choppy = [{ close: 10 }, { close: 12 }, { close: 10 }, { close: 12 }];
  assert.equal(m.directionalEfficiency(choppy), 1 / 3);
});

test('directionalBodyShare: +1 aligned, -1 opposed', () => {
  const bull = [
    { open: 10, high: 12, low: 10, close: 12 },
    { open: 12, high: 14, low: 12, close: 14 },
  ];
  assert.equal(m.directionalBodyShare(bull, 1), 1);
  assert.equal(m.directionalBodyShare(bull, -1), -1);
});

test('atrNormalizedDistance', () => {
  assert.equal(m.atrNormalizedDistance(6, 2), 3);
  assert.equal(m.atrNormalizedDistance(6, 0), 0);
  assert.equal(m.atrNormalizedDistance(6, null), 0);
});
