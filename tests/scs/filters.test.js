'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyFilters } = require('../../api/_scs-filters');

const base = { pair: 'EUR_USD', time: Date.UTC(2026, 0, 5, 8, 0), direction: 'BUY', d1Direction: 'BULLISH', impulseOrigin: 'CURRENT_DAY', status: 'TARGET_HIT', rejection: 'NONE', entryFilled: true, version: 'scs_v1' };
const signals = [
  { ...base },
  { ...base, pair: 'GBP_USD', direction: 'SELL', d1Direction: 'BEARISH', status: 'STOP_HIT', impulseOrigin: 'FRIDAY_CARRY' },
  { ...base, status: 'REJECTED', rejection: 'SPREAD_TOO_WIDE', entryFilled: false, impulseOrigin: 'PREVIOUS_DAY' },
  { ...base, version: 'scs_v2', status: 'TARGET_HIT' },
];

test('version isolation: default returns only the latest version (never mixes)', () => {
  const r = applyFilters(signals);
  assert.deepEqual(r.versionsSelected, ['scs_v2']);
  assert.equal(r.signals.length, 1);
  assert.equal(r.versionMixed, false);
});

test('explicit multi-version selection is allowed and flagged', () => {
  const r = applyFilters(signals, { versions: ['scs_v1', 'scs_v2'] });
  assert.equal(r.versionMixed, true);
  assert.equal(r.signals.length, 4);
});

test('filters by pair / direction / origin / entry / target / rejection', () => {
  const v1 = { versions: ['scs_v1'] };
  assert.equal(applyFilters(signals, { ...v1, direction: 'SELL' }).signals.length, 1);
  assert.equal(applyFilters(signals, { ...v1, impulseOrigin: 'FRIDAY_CARRY' }).signals.length, 1);
  assert.equal(applyFilters(signals, { ...v1, entry: 'MISSED' }).signals.length, 1);
  assert.equal(applyFilters(signals, { ...v1, targetReached: true }).signals.length, 1);
  assert.equal(applyFilters(signals, { ...v1, stopReached: true }).signals.length, 1);
  assert.equal(applyFilters(signals, { ...v1, rejected: true, rejectionReason: 'SPREAD_TOO_WIDE' }).signals.length, 1);
  assert.equal(applyFilters(signals, { ...v1, pair: 'GBP_USD' }).signals.length, 1);
});

test('date-range filter', () => {
  const r = applyFilters(signals, { versions: ['scs_v1'], dateFrom: Date.UTC(2026, 0, 4), dateTo: Date.UTC(2026, 0, 6) });
  assert.equal(r.signals.length, 3);
  const none = applyFilters(signals, { versions: ['scs_v1'], dateFrom: Date.UTC(2026, 1, 1) });
  assert.equal(none.signals.length, 0);
});
