'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { strategyDef } = require('../../research/breakout/config');
const { buildContext, snapshotAt, conditionAt } = require('../../research/breakout/evaluate');
const { genData, cloneData, EAT_DAY0, HOUR, M15, CURRENCIES } = require('./fixtures');

const N = 700;
const DATA = genData(N, EAT_DAY0);
const T = EAT_DAY0 + 480 * HOUR;                 // a time well inside the span
const LAST = EAT_DAY0 + (N - 1) * HOUR;
const CLASSES = ['strong', 'weak', 'mixed', 'insufficient'];

function qualOf(snap) { return snap.qualification.qualified.map((p) => p.pair + '=' + p.direction).sort(); }
function keysOf(snap) { return snap.signals.map((s) => s.dedupKey).sort(); }

test('the Evolution index builds and every currency gets a valid v2 classification', () => {
  const ctx = buildContext(strategyDef('daily'), DATA);
  assert.ok(ctx.built && ctx.built.ok, 'zero-sum M15 index available');
  const cond = conditionAt(ctx, LAST);
  for (const c of CURRENCIES) {
    assert.ok(cond[c], 'condition for ' + c);
    assert.ok(CLASSES.includes(cond[c].classification), c + ' classification valid');
  }
});

test('deterministic & repeatable: same data + settings → identical snapshot', () => {
  const a = snapshotAt(buildContext(strategyDef('daily'), DATA), T);
  const b = snapshotAt(buildContext(strategyDef('daily'), DATA), T);
  assert.deepEqual(Object.fromEntries(Object.keys(a.condition).map((c) => [c, a.condition[c].classification])),
                   Object.fromEntries(Object.keys(b.condition).map((c) => [c, b.condition[c].classification])));
  assert.deepEqual(qualOf(a), qualOf(b));
  assert.deepEqual(keysOf(a), keysOf(b));
});

test('NO look-ahead: appending future M15/H1 does not change a past decision', () => {
  const snapFull = snapshotAt(buildContext(strategyDef('daily'), DATA), T);
  // truncate BOTH streams to only candles completed by T, rebuild, evaluate at T
  const trunc = cloneData(DATA);
  for (const p of Object.keys(trunc.h1ByPair)) trunc.h1ByPair[p] = trunc.h1ByPair[p].filter((r) => r.openMs + HOUR <= T);
  for (const p of Object.keys(trunc.m15ByPair)) trunc.m15ByPair[p] = trunc.m15ByPair[p].filter((r) => r.openMs + M15 <= T);
  const snapTrunc = snapshotAt(buildContext(strategyDef('daily'), trunc), T);
  assert.deepEqual(
    Object.fromEntries(Object.keys(snapTrunc.condition).map((c) => [c, snapTrunc.condition[c].classification])),
    Object.fromEntries(Object.keys(snapFull.condition).map((c) => [c, snapFull.condition[c].classification])),
    'condition identical with/without future data');
  assert.deepEqual(qualOf(snapTrunc), qualOf(snapFull), 'qualification identical');
  assert.deepEqual(keysOf(snapTrunc), keysOf(snapFull), 'signals identical');
});

test('qualification is spread-gated: every qualified pair has a widening directional spread', () => {
  const snap = snapshotAt(buildContext(strategyDef('daily'), DATA), LAST);
  for (const q of snap.qualification.qualified) {
    assert.ok(q.direction === 'BUY' || q.direction === 'SELL');
    assert.ok(q.spread && q.spread.expanding === true, q.pair + ' spread expanding');
  }
  // qualified ⊆ all, and excluded pairs are not in qualified
  const qset = new Set(snap.qualification.qualified.map((q) => q.pair));
  for (const a of snap.qualification.all) if (!a.direction) assert.ok(!qset.has(a.pair));
});

test('signals carry the v2 fields and agree with the condition at the trigger close', () => {
  const ctx = buildContext(strategyDef('daily'), DATA);
  const snap = snapshotAt(ctx, LAST);
  assert.ok(snap.signals.length >= 1, 'at least one signal on the trending set');
  for (const s of snap.signals) {
    assert.ok(s.direction === 'BUY' || s.direction === 'SELL');
    assert.ok(['high', 'low'].includes(s.brokenBoundary));
    assert.equal(typeof s.referenceClose, 'number');
    assert.equal(typeof s.triggerCloseMs, 'number');
    assert.equal(s.evoSnapshotMs, s.triggerCloseMs, 'Evolution snapshot taken at the trigger close');
    assert.ok(s.conditionSnapshot && Object.keys(s.conditionSnapshot).length === 8, 'all 8 currencies in the snapshot');
    assert.ok(s.candidateDetail && s.candidateDetail.spread && s.candidateDetail.spread.expanding, 'spread expanding at the trigger close');
    assert.ok(s.dedupKey.startsWith('daily|bss-d-2.0.0-b5f4s16d0e0|' + s.pair + '|'));
    // the signal direction agrees with the base/quote classification at the trigger close
    if (s.direction === 'BUY') { assert.equal(s.conditionSnapshot[s.base].classification, 'strong'); assert.equal(s.conditionSnapshot[s.quote].classification, 'weak'); }
    else { assert.equal(s.conditionSnapshot[s.base].classification, 'weak'); assert.equal(s.conditionSnapshot[s.quote].classification, 'strong'); }
  }
});

test('independent strategies: daily / weekly / monthly evaluate without interfering', () => {
  const d = snapshotAt(buildContext(strategyDef('daily'), DATA), LAST);
  const w = snapshotAt(buildContext(strategyDef('weekly'), DATA), LAST);
  const m = snapshotAt(buildContext(strategyDef('monthly'), DATA), LAST);
  assert.equal(d.dirTf, 'D1'); assert.equal(d.triggerTf, 'H1');
  assert.equal(w.dirTf, 'W1'); assert.equal(w.triggerTf, 'H4');
  assert.equal(m.dirTf, 'MN1'); assert.equal(m.triggerTf, 'D1');
  assert.ok(d.condition && w.condition && m.condition);
  // the three carry distinct methodology versions
  assert.ok(d.version.startsWith('bss-d-2.0.0') && w.version.startsWith('bss-w-2.0.0') && m.version.startsWith('bss-m-2.0.0'));
});

test('a stricter breadth requirement yields no more qualified pairs', () => {
  const b5 = snapshotAt(buildContext(strategyDef('daily', { breadthMin: 5 }), DATA), LAST);
  const b7 = snapshotAt(buildContext(strategyDef('daily', { breadthMin: 7 }), DATA), LAST);
  assert.ok(b7.qualification.qualified.length <= b5.qualification.qualified.length, 'breadth 7 is at least as strict as 5');
});
