'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../../api/_scs-config');

test('enums expose the required members', () => {
  assert.deepEqual(Object.values(M.D1_DIRECTION), ['BULLISH', 'BEARISH', 'NEUTRAL']);
  assert.ok(['NO_IMPULSE', 'IMPULSE_ACTIVE', 'PULLBACK_ACTIVE', 'EXPIRED', 'INVALIDATED'].every((k) => M.H4_STATE[k]));
  assert.ok(['WAITING_SWEEP', 'WAITING_BOS', 'ENTRY_PENDING', 'ACTIVE', 'COMPLETED', 'REJECTED'].every((k) => M.H1_STATE[k]));
  assert.ok(['NORMAL', 'FRIDAY_CUTOFF', 'WEEKEND_FROZEN', 'MONDAY_REVALIDATION'].every((k) => M.MARKET_STATE[k]));
  assert.deepEqual([M.DIRECTION.BUY, M.DIRECTION.SELL], ['BUY', 'SELL']);
});

test('config carries the v1 initial values', () => {
  const c = M.CONFIG;
  assert.equal(c.atrPeriod, 14);
  assert.equal(c.swingLeft, 2); assert.equal(c.swingRight, 2);
  assert.equal(c.bosPenetrationAtr, 0.10);
  assert.equal(c.bosMinBodyAtr, 0.60);
  assert.equal(c.bosCloseLocation, 0.25);
  assert.equal(c.bosMaxRangeAtr, 2.00);
  assert.equal(c.h4MinPullbackAtr, 0.50);
  assert.equal(c.h4ImpulseLifeCandles, 12);
  assert.equal(c.h1SweepToBosWindow, 3);
  assert.equal(c.h1PendingLifeCandles, 3);
  assert.equal(c.targetR, 2);
  assert.equal(c.riskDefaultPct, 0.25);
  assert.equal(c.riskMaxPct, 0.50);
  assert.equal(c.dayAnchorHour, 17);
  assert.equal(c.dayAnchorTz, 'America/New_York');
});

test('every rejection code has human text', () => {
  for (const code of Object.values(M.REJECTION)) assert.ok(M.rejectionText(code), 'missing text for ' + code);
});

test('config is frozen (single source of truth)', () => {
  assert.throws(() => { M.CONFIG.atrPeriod = 99; }, /Cannot assign|read only/);
});
