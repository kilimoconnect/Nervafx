'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveOutcome } = require('../../research/signals/monitor');

const M5 = 5 * 60 * 1000;
// BUY entry: fill 1.1000, stop 1.0950, target 1.1100 (R=50 pips, 2R target).
const entry = { direction: 'BUY', fillMid: 1.1000, fillMs: 0, initialStop: 1.0950, target: 1.1100 };
function bar(i, o, h, l, c) { return { openMs: i * M5, open: o, high: h, low: l, close: c }; }
const holdEnd = 100 * M5;

test('target hit intrabar → CLOSED at target', () => {
  const fine = [bar(0, 1.1000, 1.1050, 1.0990, 1.1040), bar(1, 1.1040, 1.1120, 1.1030, 1.1100)];
  const r = resolveOutcome(entry, fine, holdEnd, { mid: 1.1, ms: holdEnd }, 'M5');
  assert.equal(r.status, 'CLOSED'); assert.equal(r.exitReason, 'TARGET'); assert.equal(r.exitMid, 1.1100);
});

test('stop hit intrabar → CLOSED at stop', () => {
  const fine = [bar(0, 1.1000, 1.1010, 1.0940, 1.0960)];
  const r = resolveOutcome(entry, fine, holdEnd, null, 'M5');
  assert.equal(r.exitReason, 'STOP'); assert.equal(r.exitMid, 1.0950);
});

test('both stop and target in one bar → stop-first + ambiguity + target-first alternative', () => {
  const fine = [bar(0, 1.1000, 1.1120, 1.0940, 1.1000)];   // whole range engulfs both
  const r = resolveOutcome(entry, fine, holdEnd, null, 'M15');
  assert.equal(r.exitReason, 'STOP');
  assert.equal(r.ambiguity, true);
  assert.equal(r.alternative.reason, 'TARGET');
  assert.equal(r.alternative.exitMid, 1.1100);
});

test('gap through stop → fills at the first executable (gapped) open, not the stop', () => {
  const fine = [bar(0, 1.0930, 1.0935, 1.0920, 1.0925)];   // opens below the 1.0950 stop
  const r = resolveOutcome(entry, fine, holdEnd, null, 'M5');
  assert.equal(r.exitReason, 'STOP'); assert.equal(r.exitMid, 1.0930);
  assert.equal(r.flags.gap, true);
});

test('neither hit by the holding limit → HOLD_LIMIT at the hold-exit quote', () => {
  const fine = [bar(0, 1.1000, 1.1010, 1.0990, 1.1005), bar(1, 1.1005, 1.1015, 1.0995, 1.1008)];
  const r = resolveOutcome(entry, fine, holdEnd, { mid: 1.1008, ms: holdEnd }, 'M5');
  assert.equal(r.exitReason, 'HOLD_LIMIT'); assert.equal(r.exitMid, 1.1008);
});

test('no intrabar data and no hold-exit quote → UNRESOLVED', () => {
  const r = resolveOutcome(entry, [], holdEnd, null, 'M15');
  assert.equal(r.status, 'UNRESOLVED');
});
