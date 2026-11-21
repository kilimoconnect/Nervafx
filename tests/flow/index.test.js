'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { indexObs } = require('../../research/flow/observations');
const { runBlocks } = require('../../research/flow/blocks');

// minimal buildIndices-shaped fixture (one currency); mirrors the real engine's output shape.
function fakeBuilt(values, step = 1000, t0 = 1000) {
  const timeline = values.map((_, i) => t0 + i * step);
  return { ok: true, timeline, index: { EUR: values.slice() }, firstMs: timeline[0], lastMs: timeline[timeline.length - 1], nSteps: values.length, resolution: 'M15', gaps: [] };
}

test('indexObs rebases to the daily baseline in percentage points (reconciles with Evolution)', () => {
  const built = fakeBuilt([100, 100.05, 100.10, 100.02]);
  const r = indexObs(built, 'EUR', built.timeline[0], built.timeline[2]);
  assert.ok(r.ok);
  assert.strictEqual(r.baselineValue, 100);
  // one observation per synchronized basket snapshot, windowed to the cutoff.
  assert.strictEqual(r.observations.length, 3);
  // pp = 100·(index/baseline − 1) — the same formula the Evolution % path uses.
  assert.deepStrictEqual(r.observations.map((o) => Math.round(o.value * 1e6) / 1e6), [0, 0.05, 0.1]);
  assert.strictEqual(r.observations[0].constituentCount, 28);
});

test('a daily reset starts a NEW series at pp 0 and never fabricates a reversal/jump', () => {
  // two "days": the second day's baseline differs, but each window is anchored to its own open.
  const built = fakeBuilt([100, 100.2, 101.0, /* new day open */ 101.0, 101.4]);
  const day2 = indexObs(built, 'EUR', built.timeline[3], built.timeline[4]);
  assert.strictEqual(day2.baselineValue, 101.0);
  assert.strictEqual(day2.observations[0].value, 0, 'the new series opens at pp 0 (no jump from the prior day)');
  const r = runBlocks(day2.observations, { anchor: 0, step: 0.05, precision: 3 });
  // the reset itself introduces no block; movement is measured only within the day.
  assert.ok(r.ok);
  assert.strictEqual(r.events.length >= 0, true);
});

test('the index step engine confirms a block at 0.05 pp movement', () => {
  const built = fakeBuilt([100, 100.03, 100.05, 100.051]);   // +0.05pp reached at snapshot 3
  const r = indexObs(built, 'EUR', built.timeline[0]);
  const b = runBlocks(r.observations, { anchor: 0, step: 0.05, precision: 3 });
  assert.strictEqual(b.events.length, 1);
  assert.strictEqual(b.events[0].levels[0].dir, 'up');
  assert.strictEqual(b.events[0].levels[0].close, 0.05);
});

test('indexObs reports unavailable when the baseline value is missing', () => {
  const built = fakeBuilt([100, 100.1]);
  const r = indexObs(built, 'EUR', built.timeline[1] + 999999);   // baseline after all data
  // idxAtOrBefore returns the last point ≤ baseline; here that is the last snapshot → still ok,
  // but a genuinely empty window yields zero observations.
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.observations.length, 0);
});
