'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildJournalEntry } = require('../../api/_m15/journal');

test('entry is ALWAYS scoped to the verified user — client user_id is ignored', () => {
  const row = buildJournalEntry('real-user-1', { user_id: 'attacker-2', action: 'SEEN', episodeId: 'e1' });
  assert.equal(row.user_id, 'real-user-1');           // never the client-supplied id
  assert.equal(row.episode_id, 'e1');
  assert.equal(row.action, 'SEEN');
});

test('unauthenticated (no user id) is rejected', () => {
  assert.throws(() => buildJournalEntry(null, { action: 'SEEN' }), /no authenticated user/);
});

test('invalid action is rejected', () => {
  assert.throws(() => buildJournalEntry('u1', { action: 'FILLED' }), /invalid action/);
});

test('skip requires a known reason when provided', () => {
  assert.throws(() => buildJournalEntry('u1', { action: 'SKIPPED', skipReason: 'because' }), /invalid skipReason/);
  const ok = buildJournalEntry('u1', { action: 'SKIPPED', skipReason: 'insufficient_room' });
  assert.equal(ok.skip_reason, 'insufficient_room');
});

test('manual trade details are accepted and LABELLED self-reported', () => {
  const row = buildJournalEntry('u1', { action: 'MANUALLY_TRADED', selfReported: { entry_price: 1.1, notes: 'my own fill' } });
  assert.equal(row.action, 'MANUALLY_TRADED');
  assert.equal(row.self_reported._selfReported, true);
  assert.equal(row.self_reported.entry_price, 1.1);
});

test('a SEEN mark carries no fabricated trade/fill data', () => {
  const row = buildJournalEntry('u1', { action: 'SEEN', episodeId: 'e2' });
  assert.equal(row.skip_reason, null);
  assert.equal(row.self_reported, null);              // never infers a fill
});
