'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { priceCosts, decideEntry } = require('../../research/signals/execution');
const { strategyDef, pipSize } = require('../../research/signals/config');

const def = strategyDef('today');

test('priceCosts: spread once, slippage both sides, swap per day (EUR_USD)', () => {
  const ps = pipSize('EUR_USD');               // 0.0001
  const c = priceCosts('EUR_USD', 2, 'BUY', def.costs);
  assert.ok(Math.abs(c.spread - 0.6 * ps) < 1e-12, 'spread = 0.6 pip');
  assert.ok(Math.abs(c.slippage - 2 * 0.3 * ps) < 1e-12, 'slippage = 2 × 0.3 pip');
  assert.ok(Math.abs(c.swap - 0.3 * ps * 2) < 1e-12, 'swap = 0.3 pip/day × 2 days');
  assert.ok(Math.abs(c.total - (c.spread + c.slippage + c.swap)) < 1e-12);
});

test('unlisted pair falls back to the default spread', () => {
  const c = priceCosts('ZZZ_QQQ', 0, 'SELL', def.costs);
  assert.ok(c.spread > 0 && c.swap === 0);
});

const sig = { pair: 'EUR_USD', direction: 'BUY', referenceEntry: 1.1000, fixedStop: 1.0950, maxDeviation: 0.0020 };

test('decideEntry OPEN: fill at next open, R and target frozen from the fill', () => {
  const r = decideEntry(sig, 1.1008, 1000, def);
  assert.equal(r.status, 'OPEN');
  assert.equal(r.fillMid, 1.1008);
  assert.ok(Math.abs(r.initialRisk - (1.1008 - 1.0950)) < 1e-12);
  assert.ok(Math.abs(r.target - (1.1008 + def.params.targetR * r.initialRisk)) < 1e-12);
});

test('decideEntry CANCELLED when entry deviation exceeds 0.25·ATR budget', () => {
  const r = decideEntry(sig, 1.1030, 1000, def);   // 30 pips > 20-pip maxDeviation
  assert.equal(r.status, 'CANCELLED');
  assert.ok(/deviation/.test(r.reason));
});

test('decideEntry CANCELLED when the fill is already at/through the stop', () => {
  // stop within the deviation budget so the wrong-side check (not deviation) fires
  const near = { pair: 'EUR_USD', direction: 'BUY', referenceEntry: 1.1000, fixedStop: 1.0990, maxDeviation: 0.0020 };
  const r = decideEntry(near, 1.0989, 1000, def);   // 11 pips from ref (within 20), below the stop
  assert.equal(r.status, 'CANCELLED');
  assert.ok(/wrong side/.test(r.reason));
});

test('decideEntry CANCELLED when spread exceeds 10% of entry-to-stop', () => {
  const tight = { pair: 'EUR_USD', direction: 'BUY', referenceEntry: 1.10000, fixedStop: 1.09995, maxDeviation: 0.01 };
  const r = decideEntry(tight, 1.10000, 1000, def);  // stop distance 0.5 pip; spread 0.6 pip > 10%
  assert.equal(r.status, 'CANCELLED');
  assert.ok(/spread/.test(r.reason));
});

test('decideEntry EXPIRED when no executable quote arrives', () => {
  const r = decideEntry(sig, undefined, undefined, def);
  assert.equal(r.status, 'EXPIRED');
});
