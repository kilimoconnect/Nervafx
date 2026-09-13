'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  assertM15, latestCompletedM15Ms, isStale, synchronizedTimestamp,
  inputDataHash, idempotencyKey, M15_MS,
} = require('../../api/_m15/data');
const { CONFIG } = require('../../api/_m15/config');
const { PAIRS } = require('../../api/_m15/pairs');

test('assertM15 refuses every other timeframe (M15-only enforcement §32)', () => {
  assert.equal(assertM15('M15'), 'M15');
  for (const tf of ['M1', 'M5', 'M30', 'H1', 'H4', 'D']) {
    assert.throws(() => assertM15(tf), /M15-only/);
  }
});

test('latestCompletedM15Ms returns the last CLOSED candle open-time, honoring grace', () => {
  const grace = CONFIG.processing.graceSecondsAfterClose * 1000;
  const boundary = Date.UTC(2026, 8, 11, 20, 45); // an M15 close boundary
  // Well past grace after the boundary → the candle that CLOSED at `boundary`
  // (opened one M15 earlier) is the latest completed one.
  const wellAfter = boundary + grace + 1000;
  assert.equal(latestCompletedM15Ms(wellAfter, CONFIG), boundary - M15_MS);
  // Within grace right after the boundary → step back one more candle.
  const withinGrace = boundary + 1000;
  assert.equal(latestCompletedM15Ms(withinGrace, CONFIG), boundary - 2 * M15_MS);
});

test('never returns the still-forming candle', () => {
  const boundary = Date.UTC(2026, 8, 11, 20, 45);
  const mid = boundary + 5 * 60 * 1000; // 5 min into the forming candle
  const res = latestCompletedM15Ms(mid, CONFIG);
  assert.ok(res <= boundary - M15_MS, 'result must be before the forming candle open');
});

test('isStale flags missing or too-old candles', () => {
  const now = Date.UTC(2026, 8, 11, 21, 0);
  assert.equal(isStale(null, now, CONFIG), true);
  assert.equal(isStale(now - 5 * 60 * 1000, now, CONFIG), false);
  assert.equal(isStale(now - 60 * 60 * 1000, now, CONFIG), true);
});

test('synchronizedTimestamp: aligned 28 pairs ⇒ ok/ALIGNED', () => {
  const t = Date.UTC(2026, 8, 11, 20, 30);
  const byPair = Object.fromEntries(PAIRS.map((p) => [p, t]));
  const r = synchronizedTimestamp(byPair);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ALIGNED');
  assert.equal(r.evalMs, t);
});

test('synchronizedTimestamp: a missing pair ⇒ MISSING_PAIRS (never fabricate)', () => {
  const t = Date.UTC(2026, 8, 11, 20, 30);
  const byPair = Object.fromEntries(PAIRS.map((p) => [p, t]));
  delete byPair['CHF_JPY'];
  const r = synchronizedTimestamp(byPair);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'MISSING_PAIRS');
  assert.deepEqual(r.missing, ['CHF_JPY']);
});

test('synchronizedTimestamp: a laggard ⇒ MISALIGNED, evalMs = common oldest', () => {
  const t = Date.UTC(2026, 8, 11, 20, 30);
  const byPair = Object.fromEntries(PAIRS.map((p) => [p, t]));
  byPair['EUR_USD'] = t + M15_MS; // one pair is one candle ahead
  const r = synchronizedTimestamp(byPair);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'MISALIGNED');
  assert.equal(r.evalMs, t); // the common (oldest) frame, not the ahead one
  assert.deepEqual(r.laggards, ['EUR_USD']);
});

test('inputDataHash + idempotencyKey are deterministic and change-sensitive', () => {
  const t = Date.UTC(2026, 8, 11, 20, 30);
  const c = (close) => [{ openMs: t, open: 1.1, high: 1.11, low: 1.09, close }];
  const byPairA = Object.fromEntries(PAIRS.map((p) => [p, c(1.1)]));
  const byPairB = Object.fromEntries(PAIRS.map((p) => [p, c(1.1)]));
  assert.equal(inputDataHash(byPairA, t), inputDataHash(byPairB, t));
  const mutated = { ...byPairA, EUR_USD: c(1.2) };
  assert.notEqual(inputDataHash(mutated, t), inputDataHash(byPairA, t));

  const k1 = idempotencyKey(t, CONFIG.version, 'abc');
  const k2 = idempotencyKey(t, CONFIG.version, 'abc');
  assert.equal(k1, k2);
  assert.notEqual(idempotencyKey(t + M15_MS, CONFIG.version, 'abc'), k1);
});
