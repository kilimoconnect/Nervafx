'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { plannedCloses, closeOf, snapshotStatus, snapshotKey, freshness } = require('../../api/_m15/snapshot');

const M15 = 15 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 10, 12, 7, 0);  // 12:07 UTC → latest completed frame open = 11:45
const F = (h, m) => Date.UTC(2026, 8, 10, h, m, 0);

test('missed invocations: many completed closes are planned, newest first, bounded', () => {
  const plan = plannedCloses(NOW, new Set(), { maxCatchup: 8 });
  assert.equal(plan.length, 8);
  assert.equal(plan[0], F(11, 45));                 // latest completed frame
  assert.equal(plan[1], F(11, 30));
  assert.equal(plan[7], F(10, 0));                  // catch-up bound honoured
});

test('duplicate/overlap: closes already COMPLETE are skipped (no reprocessing)', () => {
  const done = new Set([F(11, 45), F(11, 30)]);
  const plan = plannedCloses(NOW, done, { maxCatchup: 8 });
  assert.ok(!plan.includes(F(11, 45)));
  assert.ok(!plan.includes(F(11, 30)));
  assert.equal(plan.length, 6);
});

test('idempotent convergence: after processing, a re-run plans nothing new', () => {
  const done = new Set();
  let plan = plannedCloses(NOW, done, { maxCatchup: 4 });
  for (const f of plan) done.add(f);               // simulate COMPLETE writes
  const plan2 = plannedCloses(NOW, done, { maxCatchup: 4 });
  assert.equal(plan2.length, 0);
});

test('closeOf: frame open + 15m is the exact M15 close', () => {
  assert.equal(closeOf(F(11, 45)), F(12, 0));
});

test('snapshotStatus: COMPLETE only when all 28 pairs on one aligned frame', () => {
  assert.equal(snapshotStatus({ pairsProcessed: 28, pairsExpected: 28, syncState: 'ALIGNED', missingPairs: [] }), 'COMPLETE');
  assert.equal(snapshotStatus({ pairsProcessed: 27, pairsExpected: 28, syncState: 'ALIGNED', missingPairs: ['CHF_JPY'] }), 'INCOMPLETE');
  assert.equal(snapshotStatus({ pairsProcessed: 28, pairsExpected: 28, syncState: 'MISALIGNED', missingPairs: [] }), 'INCOMPLETE');
});

test('snapshotKey: same (frame,version,inputs) ⇒ same key; different inputs ⇒ different', () => {
  const a = snapshotKey(F(11, 45), 'm15-cfg-1.1.0a', 'hash1');
  const b = snapshotKey(F(11, 45), 'm15-cfg-1.1.0a', 'hash1');
  const c = snapshotKey(F(11, 45), 'm15-cfg-1.1.0a', 'hash2');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('freshness: fresh just after close, stale when too old', () => {
  const close = F(12, 0);
  assert.equal(freshness(close, close + 60 * 1000).stale, false);
  assert.equal(freshness(close, close + 60 * 60 * 1000).stale, true);
});
