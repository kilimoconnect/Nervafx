'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  zonedWallToUtcMs, snapToM15Ms, lastCompletedH1CloseMs,
  h1UntilMs, m15UntilMs, resolveEvaluationTime, buildEvaluationContext,
} = require('../../api/_lfe-evaltime');

const HOUR = 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const iso = (s) => new Date(s).getTime();

test('zonedWallToUtcMs: UTC is identity', () => {
  assert.equal(zonedWallToUtcMs(2026, 8, 14, 10, 30, 'UTC'), Date.UTC(2026, 7, 14, 10, 30, 0));
});

test('zonedWallToUtcMs: New York EST (winter, UTC-5)', () => {
  // 2026-01-15 10:00 America/New_York = 15:00 UTC
  assert.equal(zonedWallToUtcMs(2026, 1, 15, 10, 0, 'America/New_York'), Date.UTC(2026, 0, 15, 15, 0, 0));
});

test('zonedWallToUtcMs: New York EDT (summer DST, UTC-4)', () => {
  // 2026-07-15 10:00 America/New_York = 14:00 UTC — proves DST is resolved live
  assert.equal(zonedWallToUtcMs(2026, 7, 15, 10, 0, 'America/New_York'), Date.UTC(2026, 6, 15, 14, 0, 0));
});

test('snapToM15Ms snaps DOWN to the completed 15-min boundary', () => {
  assert.equal(snapToM15Ms(iso('2026-08-14T10:37:00Z')), iso('2026-08-14T10:30:00Z'));
  assert.equal(snapToM15Ms(iso('2026-08-14T10:44:59Z')), iso('2026-08-14T10:30:00Z'));
  assert.equal(snapToM15Ms(iso('2026-08-14T10:30:00Z')), iso('2026-08-14T10:30:00Z'));
  assert.equal(snapToM15Ms(iso('2026-08-14T10:45:00Z')), iso('2026-08-14T10:45:00Z'));
});

test('H1 completion cutoff matches the worked example (10:30 → H1 closed 10:00)', () => {
  const evalMs = iso('2026-08-14T10:30:00Z');
  assert.equal(lastCompletedH1CloseMs(evalMs), iso('2026-08-14T10:00:00Z'));
  // usable H1 opens are ≤ 09:30, so the 10:00-open (10:00–11:00) candle is excluded
  assert.equal(h1UntilMs(evalMs), iso('2026-08-14T09:30:00Z'));
  assert.ok(iso('2026-08-14T09:00:00Z') <= h1UntilMs(evalMs));
  assert.ok(iso('2026-08-14T10:00:00Z') > h1UntilMs(evalMs));
});

test('M15 cutoff: forming candle excluded, last completed included', () => {
  const evalMs = iso('2026-08-14T10:30:00Z');
  assert.equal(m15UntilMs(evalMs), iso('2026-08-14T10:15:00Z'));
  assert.ok(iso('2026-08-14T10:15:00Z') <= m15UntilMs(evalMs)); // 10:15–10:30 usable
  assert.ok(iso('2026-08-14T10:30:00Z') > m15UntilMs(evalMs));  // 10:30–10:45 forming
});

const coverage = {
  earliestSelectable: iso('2025-06-01T00:00:00Z'),
  earliestSelectableIso: '2025-06-01T00:00:00.000Z',
  latestAvailable: iso('2026-08-14T16:00:00Z'),
  commonLatestIso: '2026-08-14T16:00:00.000Z',
};

test('resolveEvaluationTime snaps inside coverage', () => {
  const r = resolveEvaluationTime({ iso: '2026-08-14T10:37:00Z' }, coverage);
  assert.equal(r.ok, true);
  assert.equal(r.evaluationTimeUtc, iso('2026-08-14T10:30:00Z'));
});

test('resolveEvaluationTime rejects selections before the dataset', () => {
  const r = resolveEvaluationTime({ iso: '2025-01-01T00:00:00Z' }, coverage);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'BEFORE_COVERAGE');
});

test('resolveEvaluationTime rejects selections after the dataset', () => {
  const r = resolveEvaluationTime({ iso: '2027-01-01T00:00:00Z' }, coverage);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AFTER_COVERAGE');
});

test('buildEvaluationContext defaults to latest available when no time given', () => {
  const ctx = buildEvaluationContext(coverage, { displayTimezone: 'America/New_York' });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.mode, 'latest_available');
  assert.equal(ctx.evaluationTimeUtc, '2026-08-14T16:00:00.000Z');
  assert.equal(ctx.requestedTime, null);
  assert.equal(ctx.displayTimezone, 'America/New_York');
});

test('buildEvaluationContext marks an earlier moment as historical', () => {
  const ctx = buildEvaluationContext(coverage, { iso: '2026-08-14T10:37:00Z' });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.mode, 'historical');
  assert.equal(ctx.evaluationTimeUtc, '2026-08-14T10:30:00.000Z');
  assert.equal(ctx.lastCompletedH1, '2026-08-14T10:00:00.000Z');
});
