'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { M15, researchHealth, operatingChecks, shouldNotify } = require('../../research/m15/health');

const T0 = Date.UTC(2026, 8, 25, 20, 30, 0);         // a frame open; close = 20:45
const view = (over = {}) => ({ frameOpenMs: T0, aligned: true, missing: [], laggards: [], ...over });

test('researchHealth: complete, fresh snapshot reports UTC+EAT close and 28/28', () => {
  const h = researchHealth(view(), { nowMs: T0 + M15 + 60 * 1000 });
  assert.equal(h.complete, true); assert.equal(h.stale, false);
  assert.equal(h.pairsPresent, 28);
  assert.match(h.latestCloseEat, /EAT$/);
  assert.equal(h.latestCloseUtc, new Date(T0 + M15).toISOString());
});

test('researchHealth: missing pairs ⇒ not complete; old data ⇒ stale', () => {
  const h = researchHealth(view({ aligned: false, missing: ['CHF_JPY'] }), { nowMs: T0 + M15 + 3 * 3600e3 });
  assert.equal(h.complete, false); assert.equal(h.stale, true); assert.equal(h.pairsPresent, 27);
});

test('operatingChecks flags late / incomplete / gap / stale / version-change / duplicate', () => {
  const c = operatingChecks({ nowMs: T0 + M15 + 20 * 60 * 1000, frameOpenMs: T0, prevFrameOpenMs: T0 - 3 * M15, weekend: false, pairsPresent: 27, version: 'v2', prevVersion: 'v1', seenFrames: new Set([T0]) });
  assert.equal(c.lateCandle, true);           // 20 min after close
  assert.equal(c.incompleteSnapshot, true);   // 27 pairs
  assert.equal(c.gap, true);                   // prev frame 3 intervals back (non-weekend)
  assert.equal(c.staleSignal, true);
  assert.equal(c.versionChanged, true);        // ⇒ restart cohort
  assert.equal(c.duplicateRun, true);
});

test('shouldNotify: REPLAY and BACKFILL never notify (no live-evidence leak)', () => {
  const base = { complete: true, stale: false, hasSelectedCandidate: true, episodeId: 'e', seenEpisodeIds: new Set() };
  assert.equal(shouldNotify({ ...base, mode: 'REPLAY' }).reason, 'REPLAY');
  assert.equal(shouldNotify({ ...base, mode: 'BACKFILL' }).reason, 'BACKFILL');
});

test('shouldNotify: incomplete / stale / duplicate are blocked', () => {
  const base = { mode: 'LIVE', hasSelectedCandidate: true, episodeId: 'e' };
  assert.equal(shouldNotify({ ...base, complete: false, stale: false, seenEpisodeIds: new Set() }).reason, 'INCOMPLETE');
  assert.equal(shouldNotify({ ...base, complete: true, stale: true, seenEpisodeIds: new Set() }).reason, 'STALE');
  assert.equal(shouldNotify({ ...base, complete: true, stale: false, seenEpisodeIds: new Set(['e']) }).reason, 'DUPLICATE');
});

test('shouldNotify: with NO selected candidate (Stage 5 none passed) nothing ever notifies', () => {
  const r = shouldNotify({ mode: 'LIVE', complete: true, stale: false, hasSelectedCandidate: false, episodeId: 'e', seenEpisodeIds: new Set() });
  assert.equal(r.notify, false); assert.equal(r.reason, 'NO_SELECTED_CANDIDATE');
});

test('shouldNotify: only a LIVE, complete, fresh, NEW episode with a selected candidate notifies', () => {
  const r = shouldNotify({ mode: 'LIVE', complete: true, stale: false, hasSelectedCandidate: true, episodeId: 'e', seenEpisodeIds: new Set() });
  assert.equal(r.notify, true); assert.equal(r.reason, 'LIVE_NEW');
});
