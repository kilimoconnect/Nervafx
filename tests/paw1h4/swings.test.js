'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectFractals, confirmedAsOf, lastOfType } = require('../../research/paw1h4/swings');

const IV = 4 * 3600000;                       // treat candles as H4 for timing
const START = Date.UTC(2026, 0, 5, 0, 0, 0);  // Mon
function c(i, h, l) { const openMs = START + i * IV; return { openMs, closeMs: openMs + IV, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2 }; }

test('strict swing high: extreme vs confirmation time stored separately', () => {
  const cands = [c(0, 1, 0), c(1, 2, 0), c(2, 3, 0), c(3, 2, 0), c(4, 1, 0)];
  const p = detectFractals(cands, { left: 2, right: 2 });
  const highs = p.filter((x) => x.type === 'HIGH');
  assert.equal(highs.length, 1);
  assert.equal(highs[0].index, 2);
  assert.equal(highs[0].price, 3);
  assert.equal(highs[0].extremeTimeMs, cands[2].openMs);       // the pivot bar
  assert.equal(highs[0].confirmedAtMs, cands[4].closeMs);      // knowable only when i+2 closes
  assert.ok(highs[0].confirmedAtMs > highs[0].extremeTimeMs);
});

test('equal extremes do NOT qualify (strict)', () => {
  const cands = [c(0, 1, 0), c(1, 2, 0), c(2, 3, 0), c(3, 3, 0), c(4, 1, 0)]; // tie on the right
  const highs = detectFractals(cands, { left: 2, right: 2 }).filter((x) => x.type === 'HIGH');
  assert.equal(highs.length, 0);
});

test('swing low is symmetric', () => {
  const cands = [c(0, 9, 5), c(1, 9, 4), c(2, 9, 2), c(3, 9, 4), c(4, 9, 5)];
  const lows = detectFractals(cands, { left: 2, right: 2 }).filter((x) => x.type === 'LOW');
  assert.equal(lows.length, 1);
  assert.equal(lows[0].price, 2);
  assert.equal(lows[0].index, 2);
});

test('outside-bar extreme qualifying as BOTH is flagged and excluded from sequencing', () => {
  // index 2 is both the highest high and the lowest low of the 5-bar window.
  const cands = [c(0, 5, 3), c(1, 4, 2), c(2, 9, 0), c(3, 4, 2), c(4, 5, 3)];
  const all = detectFractals(cands, { left: 2, right: 2 });
  const both = all.filter((x) => x.bothSide);
  assert.ok(both.length >= 1, 'outside bar flagged bothSide');
  const seq = confirmedAsOf(all, cands[4].closeMs);
  assert.equal(seq.filter((x) => x.index === 2).length, 0, 'bothSide pivot excluded from sequencing');
});

test('as-of causality: a pivot is unknown before its confirmation close', () => {
  const cands = [c(0, 1, 0), c(1, 2, 0), c(2, 3, 0), c(3, 2, 0), c(4, 1, 0)];
  const all = detectFractals(cands, { left: 2, right: 2 });
  const before = confirmedAsOf(all, cands[4].closeMs - 1);  // one ms before confirm
  const at = confirmedAsOf(all, cands[4].closeMs);
  assert.equal(before.length, 0);
  assert.equal(at.length, 1);
});

test('lastOfType returns most-recent-first', () => {
  // two rising highs: indices 2 (h=3) then 6 (h=5)
  const cands = [c(0, 1, 0), c(1, 2, 0), c(2, 3, 0), c(3, 2, 0), c(4, 1, 0), c(5, 4, 0), c(6, 5, 0), c(7, 4, 0), c(8, 1, 0)];
  const conf = confirmedAsOf(detectFractals(cands, { left: 2, right: 2 }), cands[8].closeMs);
  const twoHighs = lastOfType(conf, 'HIGH', 2);
  assert.equal(twoHighs.length, 2);
  assert.equal(twoHighs[0].price, 5);   // most recent first
  assert.equal(twoHighs[1].price, 3);
});
