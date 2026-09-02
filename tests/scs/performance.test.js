'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computePerformance, sessionOf, reduceStats } = require('../../api/_scs-performance');

const T = (h) => Date.UTC(2026, 0, 5, h, 0); // Monday 2026-01-05
const sig = (status, pair, hour, origin) => ({ status, pair, time: T(hour), impulseOrigin: origin, entryFilled: status === 'TARGET_HIT' || status === 'STOP_HIT', version: 'scs_v1' });

test('sessionOf buckets by UTC hour', () => {
  assert.equal(sessionOf(T(3)), 'ASIA');
  assert.equal(sessionOf(T(9)), 'LONDON');
  assert.equal(sessionOf(T(15)), 'NEWYORK');
});

test('core stats: win rate, avg R, expectancy, profit factor, drawdown, streak', () => {
  const signals = [
    sig('TARGET_HIT', 'EUR_USD', 8, 'CURRENT_DAY'),   // +2
    sig('STOP_HIT', 'EUR_USD', 9, 'PREVIOUS_DAY'),    // -1
    sig('STOP_HIT', 'GBP_USD', 10, 'PREVIOUS_DAY'),   // -1
    sig('TARGET_HIT', 'GBP_USD', 11, 'FRIDAY_CARRY'), // +2
    sig('PENDING', 'AUD_USD', 12, 'CURRENT_DAY'),     // not a realized trade
  ];
  const p = computePerformance(signals);
  assert.equal(p.totalSignals, 5);
  assert.equal(p.totalTrades, 4);
  assert.equal(p.winRate, 0.5);
  assert.equal(p.avgR, 0.5);
  assert.equal(p.expectancyR, 0.5);
  assert.equal(p.profitFactor, 2);       // grossWin 4 / grossLoss 2
  assert.equal(p.maxDrawdownR, 2);       // equity 2,1,0,2 → peak 2 → 0
  assert.equal(p.longestLosingStreak, 2);
});

test('breakdowns by pair / session / origin, and before/after costs', () => {
  const signals = [sig('TARGET_HIT', 'EUR_USD', 8, 'CURRENT_DAY'), sig('STOP_HIT', 'EUR_USD', 9, 'CURRENT_DAY')];
  const p = computePerformance(signals, { costR: 0.1 });
  assert.equal(p.byPair.EUR_USD.trades, 2);
  assert.equal(p.byOrigin.CURRENT_DAY.trades, 2);
  assert.ok(p.bySession.LONDON);
  assert.equal(p.beforeCosts.avgR, 0.5);
  assert.equal(p.afterCosts.avgR, 0.4);  // 0.5 − 0.1 cost per trade
});

test('never infers missing outcomes (only TARGET_HIT / STOP_HIT are trades)', () => {
  const p = computePerformance([sig('EXPIRED', 'EUR_USD', 8), sig('REJECTED', 'EUR_USD', 9), sig('CANCELLED', 'EUR_USD', 10)]);
  assert.equal(p.totalSignals, 3);
  assert.equal(p.totalTrades, 0);
  assert.equal(p.avgR, 0);
});

test('empty input is safe', () => {
  const p = computePerformance([]);
  assert.equal(p.totalTrades, 0);
  assert.equal(p.profitFactor, 0);
});
