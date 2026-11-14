'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { strategyDef } = require('../../research/breakout/config');
const { buildContext, snapshotAt, strengthAt, strengthAsOf } = require('../../research/breakout/evaluate');
const { scoreSum, allComplete } = require('../../research/breakout/strength');
const { genH1, cloneH1, EAT_DAY0, HOUR } = require('./fixtures');

const N = 700;
const DATA = genH1(N, EAT_DAY0);
const T = EAT_DAY0 + 480 * HOUR;                 // a close time well inside the span
const LAST = EAT_DAY0 + (N - 1) * HOUR;

function keysOf(snap) { return snap.signals.map((s) => s.dedupKey).sort(); }
function qualOf(snap) { return snap.qualification.qualified.map((p) => p.pair + '=' + p.direction).sort(); }

test('complete data → the eight currency scores sum to zero (through real aggregation)', () => {
  const ctx = buildContext(strategyDef('daily'), DATA);
  const snap = snapshotAt(ctx, LAST);
  assert.ok(allComplete(snap.strength), 'all currencies complete');
  assert.equal(scoreSum(snap.strength), 0);
});

test('deterministic & repeatable: same data + settings → identical snapshot', () => {
  const a = snapshotAt(buildContext(strategyDef('daily'), DATA), T);
  const b = snapshotAt(buildContext(strategyDef('daily'), DATA), T);
  assert.deepEqual(a.strength, b.strength);
  assert.deepEqual(qualOf(a), qualOf(b));
  assert.deepEqual(keysOf(a), keysOf(b));
});

test('NO look-ahead: appending future candles does not change a past decision', () => {
  const ctxFull = buildContext(strategyDef('daily'), DATA);
  const snapFull = snapshotAt(ctxFull, T);
  // truncate to only candles completed by T, rebuild, evaluate at T
  const trunc = cloneH1(DATA);
  for (const p of Object.keys(trunc)) trunc[p] = trunc[p].filter((r) => r.openMs + HOUR <= T);
  const snapTrunc = snapshotAt(buildContext(strategyDef('daily'), trunc), T);
  assert.deepEqual(snapTrunc.strength, snapFull.strength, 'strength identical with/without future data');
  assert.deepEqual(qualOf(snapTrunc), qualOf(snapFull), 'qualification identical');
  assert.deepEqual(keysOf(snapTrunc), keysOf(snapFull), 'signals identical');
});

test('strength timeline (binary-searched) matches the direct recompute at arbitrary times', () => {
  const ctx = buildContext(strategyDef('daily'), DATA);
  for (let k = 50; k < N; k += 37) {
    const ms = EAT_DAY0 + k * HOUR + 123;        // deliberately not on a candle boundary
    const fromTimeline = strengthAt(ctx, ms);
    const direct = strengthAsOf(ctx, ms);
    assert.deepEqual(
      Object.fromEntries(Object.keys(fromTimeline).map((c) => [c, fromTimeline[c].classification + ':' + fromTimeline[c].score])),
      Object.fromEntries(Object.keys(direct).map((c) => [c, direct[c].classification + ':' + direct[c].score])),
      'timeline == direct at ms=' + ms,
    );
  }
});

test('signals carry the fields needed to explain and reproduce the decision', () => {
  const ctx = buildContext(strategyDef('daily'), DATA);
  const snap = snapshotAt(ctx, LAST);
  assert.ok(snap.signals.length >= 1, 'at least one signal on the trending set');
  for (const s of snap.signals) {
    assert.ok(s.direction === 'BUY' || s.direction === 'SELL');
    assert.ok(['high', 'low'].includes(s.brokenBoundary));
    assert.equal(typeof s.referenceClose, 'number');
    assert.equal(typeof s.triggerCloseMs, 'number');
    assert.ok(s.strengthSnapshot && Object.keys(s.strengthSnapshot).length === 8, 'all 8 currencies in the snapshot');
    assert.ok(s.dedupKey.startsWith('daily|bss-d-1.0.0|' + s.pair + '|'));
    // the signal direction agrees with the base/quote classification at the trigger close
    if (s.direction === 'BUY') { assert.equal(s.strengthSnapshot[s.base].classification, 'strong'); assert.equal(s.strengthSnapshot[s.quote].classification, 'weak'); }
    else { assert.equal(s.strengthSnapshot[s.base].classification, 'weak'); assert.equal(s.strengthSnapshot[s.quote].classification, 'strong'); }
  }
});

test('independent strategies: daily / weekly / monthly evaluate without interfering', () => {
  const d = snapshotAt(buildContext(strategyDef('daily'), DATA), LAST);
  const w = snapshotAt(buildContext(strategyDef('weekly'), DATA), LAST);
  const m = snapshotAt(buildContext(strategyDef('monthly'), DATA), LAST);
  assert.equal(d.dirTf, 'D1'); assert.equal(d.triggerTf, 'H1');
  assert.equal(w.dirTf, 'W1'); assert.equal(w.triggerTf, 'H4');
  assert.equal(m.dirTf, 'MN1'); assert.equal(m.triggerTf, 'D1');
  // each produced its own independent strength (they need not agree)
  assert.ok(d.strength && w.strength && m.strength);
});

test('threshold is a per-strategy assumption: a stricter threshold yields no more qualified pairs', () => {
  const t5 = snapshotAt(buildContext(strategyDef('daily', { strongThreshold: 5 }), DATA), LAST);
  const t7 = snapshotAt(buildContext(strategyDef('daily', { strongThreshold: 7 }), DATA), LAST);
  assert.ok(t7.qualification.qualified.length <= t5.qualification.qualified.length, 'threshold 7 is at least as strict as 5');
});
