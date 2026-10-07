'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gen = require('../../scripts/research/build-replay');
const { STATES } = require('../../research/m15/classifier');

const M15 = 15 * 60 * 1000;
const payload = gen.build();
const allFrames = Object.values(payload.datasets).flatMap((d) => d.frames);

// ── no-lookahead: no event is dated after the frame's close ───────────────────
test('QA: no frame shows an event later than its own close', () => {
  for (const f of allFrames) for (const e of f.events) assert.ok(Date.parse(e.utc) <= f.asOfCloseMs, `${f.asOfCloseUtc} shows event ${e.utc}`);
});

// ── no future-adjusted thresholds: calibration version constant everywhere ────
test('QA: calibration version is fixed across every frame', () => {
  const vers = new Set(allFrames.map((f) => f.calibrationVersion));
  assert.equal(vers.size, 1);
  assert.equal([...vers][0], 'cal-v1');
});

// ── immutability: a past close is identical whether or not later data exists ──
test('QA: a historical frame cannot be changed by later candles', () => {
  const T = Date.UTC(2026, 8, 11, 0, 0, 0);
  const cands = gen.eurgbpDescent(T);
  const H = gen.network(T, 192, { GBP: 0.03, EUR: -0.03 }, 'EUR_GBP', cands);
  const tPast = cands[100].openMs + M15;
  const withFuture = gen.buildFrame('EUR_GBP', H, tPast, null, 0);
  const Htrunc = {}; for (const p of Object.keys(H)) Htrunc[p] = H[p].filter((c) => c.openMs + M15 <= tPast);
  const truncated = gen.buildFrame('EUR_GBP', Htrunc, tPast, null, 0);
  assert.deepEqual(truncated, withFuture);
});

// ── no later swing confirmation leaks: provisional leg is unconfirmed ─────────
test('QA: the current leg is provisional (no backdated/later pivot shown)', () => {
  for (const f of allFrames) {
    if (f.structure && f.structure.provisionalLeg) assert.equal(f.structure.provisionalLeg.confirmed, false);
  }
});

// ── fixtures behave as required ───────────────────────────────────────────────
test('QA: descent reaches accepted bearish; shock is rejected and never accepted', () => {
  const dStates = new Set(payload.datasets.descent.frames.map((f) => f.displayState));
  const sStates = new Set(payload.datasets.shock.frames.map((f) => f.displayState));
  assert.ok(dStates.has(STATES.ACCEPTED_TREND_DOWN) || dStates.has(STATES.ACCELERATING_TREND_DOWN));
  assert.ok(sStates.has(STATES.REVERSAL_UP));
  assert.ok(sStates.has(STATES.EMERGING_MOVE_DOWN));
  assert.ok(!sStates.has(STATES.ACCEPTED_TREND_DOWN));
});

// ── UNAVAILABLE reasons demonstrated ──────────────────────────────────────────
test('QA: data-quality demo shows insufficient, incomplete, and stale reasons', () => {
  const reasons = payload.datasets.quality.frames.map((f) => f.displayReason);
  assert.ok(reasons.some((r) => /INSUFFICIENT/.test(r)));
  assert.ok(reasons.some((r) => /INCOMPLETE/.test(r)));
  assert.ok(reasons.some((r) => /STALE/.test(r)));
  for (const f of payload.datasets.quality.frames) assert.equal(f.displayState, STATES.UNAVAILABLE);
});

// ── labelling / no trade-signal surface ───────────────────────────────────────
test('QA: dataset is labelled research-only', () => {
  assert.equal(payload.meta.disclaimer, 'research classification — not a trade signal');
});
