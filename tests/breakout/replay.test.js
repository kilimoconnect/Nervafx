'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { strategyDef } = require('../../research/breakout/config');
const { buildContext, snapshotAt } = require('../../research/breakout/evaluate');
const { replayAt, triggerCloseTimes, latestTriggerClose, stepTriggerClose, sweepSignals } = require('../../research/breakout/replay');
const { genH1, EAT_DAY0, HOUR } = require('./fixtures');

const N = 700;
const DATA = genH1(N, EAT_DAY0);
const LAST = EAT_DAY0 + (N - 1) * HOUR;
const ctx = () => buildContext(strategyDef('daily'), DATA);

test('PARITY: live snapshot signals are reproduced by the window sweep (same dedup ids)', () => {
  const c = ctx();
  const rep = replayAt(c, LAST, EAT_DAY0);
  const windowKeys = new Set(rep.signalsInWindow.map((s) => s.dedupKey));
  // every signal the live snapshot would publish at the latest close is present in the window
  for (const s of rep.snapshot.signals) assert.ok(windowKeys.has(s.dedupKey), 'snapshot signal in window: ' + s.dedupKey);
});

test('PARITY: every window signal is reproduced by snapshotAt() at its own trigger close', () => {
  const c = ctx();
  const win = sweepSignals(c, EAT_DAY0, LAST);
  assert.ok(win.length > 5, 'several signals to check');
  // sample ~40 spread across the window to keep it fast
  const step = Math.max(1, Math.floor(win.length / 40));
  for (let i = 0; i < win.length; i += step) {
    const s = win[i];
    const snap = snapshotAt(c, s.triggerCloseMs);
    assert.ok(snap.signals.some((x) => x.dedupKey === s.dedupKey),
      'snapshot at ' + s.triggerCloseMs + ' reproduces ' + s.dedupKey);
  }
});

test('repeated replay is identical for identical data + settings', () => {
  const a = replayAt(ctx(), LAST, EAT_DAY0);
  const b = replayAt(ctx(), LAST, EAT_DAY0);
  assert.deepEqual(a.signalsInWindow.map((s) => s.dedupKey), b.signalsInWindow.map((s) => s.dedupKey));
  assert.deepEqual(a.snapshot.signals.map((s) => s.dedupKey), b.snapshot.signals.map((s) => s.dedupKey));
});

test('a timestamp between trigger closes uses the latest completed trigger candle', () => {
  const c = ctx();
  const closes = triggerCloseTimes(c, EAT_DAY0, LAST);
  assert.ok(closes.length > 10);
  // pick a close, then query 20 minutes AFTER it (before the next one)
  const t = closes[Math.floor(closes.length / 2)];
  const between = t + 20 * 60 * 1000;
  const lt = latestTriggerClose(c, between);
  assert.equal(lt, t, 'latest completed close is the one at t');
  const rep = replayAt(c, between, EAT_DAY0);
  assert.equal(rep.latestTriggerCloseMs, t);
  assert.ok(rep.atBetweenCloses, 'flagged as between closes');
  // every trigger eval is at a close <= the queried time (no look-ahead)
  for (const te of rep.snapshot.triggerEvals) if (te.triggerCloseMs != null) assert.ok(te.triggerCloseMs <= between);
});

test('stepping: next/prev move to adjacent distinct trigger closes', () => {
  const c = ctx();
  const closes = triggerCloseTimes(c, EAT_DAY0, LAST);
  const i = Math.floor(closes.length / 2);
  assert.equal(stepTriggerClose(c, closes[i], 1), closes[i + 1], 'next close');
  assert.equal(stepTriggerClose(c, closes[i], -1), closes[i - 1], 'prev close');
  // stepping past the end returns null (cannot play beyond the last completed candle)
  assert.equal(stepTriggerClose(c, closes[closes.length - 1], 1), null);
});

test('replay writes nothing: the engine functions take no db handle and are pure', () => {
  // structural guarantee — replay never receives a Supabase client; calling twice is identical
  const a = sweepSignals(ctx(), EAT_DAY0, LAST).length;
  const b = sweepSignals(ctx(), EAT_DAY0, LAST).length;
  assert.equal(a, b);
  assert.equal(replayAt.length, 3, 'replayAt(ctx, atMs, windowFromMs) — no sb param');
});

test('trigger close times are sorted, unique and within range', () => {
  const c = ctx();
  const closes = triggerCloseTimes(c, EAT_DAY0, LAST);
  for (let i = 1; i < closes.length; i++) assert.ok(closes[i] > closes[i - 1], 'strictly increasing / unique');
  assert.ok(closes[0] > EAT_DAY0 && closes[closes.length - 1] <= LAST);
});
