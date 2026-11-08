'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildTrade, dedupKey } = require('../../research/signals/lifecycle');
const { priceCosts } = require('../../research/signals/execution');
const { strategyDef } = require('../../research/signals/config');

const def = strategyDef('today');
const sig = {
  strategyKey: 'today', version: def.version, pair: 'EUR_USD', direction: 'BUY', rank: 1,
  publishedAtMs: 1000, entryExpiryMs: 1000 + def.entryMs, entryCloseMs: 1000,
  fixedStop: 1.0950, indicativeTarget: 1.1100,
};
const openEntry = { status: 'OPEN', fillMid: 1.1000, fillMs: 2000, initialStop: 1.0950, target: 1.1100, initialRisk: 0.005 };

test('CLOSED win at target: net R = (2R − costs)/R, events PUBLISHED→ENTERED→TARGET', () => {
  const outcome = { status: 'CLOSED', exitReason: 'TARGET', exitMid: 1.1100, exitMs: 2000 + 60000, monitorTf: 'M5' };
  const t = buildTrade(sig, openEntry, outcome, def);
  assert.equal(t.status, 'CLOSED'); assert.equal(t.result, 'win');
  const costs = priceCosts('EUR_USD', 60000 / 86400000, 'BUY', def.costs);
  const expNetR = (0.01 - costs.total) / 0.005;
  assert.ok(Math.abs(t.netR - expNetR) < 1e-9, 'net R after costs');
  assert.deepEqual(t.events.map((e) => e.type), ['PUBLISHED', 'ENTERED', 'TARGET']);
});

test('CLOSED loss at stop: negative net R, result loss', () => {
  const outcome = { status: 'CLOSED', exitReason: 'STOP', exitMid: 1.0950, exitMs: 2000 + 60000, monitorTf: 'M15' };
  const t = buildTrade(sig, openEntry, outcome, def);
  assert.equal(t.result, 'loss'); assert.ok(t.netR < -1, 'loss beyond -1R after costs');
});

test('ambiguous close records the target-first alternative net R', () => {
  const outcome = { status: 'CLOSED', exitReason: 'STOP', exitMid: 1.0950, exitMs: 2000 + 60000, monitorTf: 'M15', ambiguity: true, alternative: { reason: 'TARGET', exitMid: 1.1100 } };
  const t = buildTrade(sig, openEntry, outcome, def);
  assert.equal(t.ambiguityFlag, true);
  assert.ok(t.dataQuality.altNetR > 1, 'alternative (target-first) would have been a win');
});

test('EXPIRED / CANCELLED pass through with no outcome and the right events', () => {
  const e1 = buildTrade(sig, { status: 'EXPIRED', reason: 'no quote' }, null, def);
  assert.equal(e1.status, 'EXPIRED'); assert.equal(e1.netR, null);
  assert.deepEqual(e1.events.map((e) => e.type), ['PUBLISHED', 'EXPIRED']);
  const e2 = buildTrade(sig, { status: 'CANCELLED', reason: 'deviation' }, null, def);
  assert.deepEqual(e2.events.map((e) => e.type), ['PUBLISHED', 'CANCELLED']);
});

test('missing intrabar data → UNRESOLVED; dataset-end while holding → kept OPEN', () => {
  const unres = buildTrade(sig, openEntry, { status: 'UNRESOLVED', reason: 'no intrabar data', monitorTf: 'M15' }, def);
  assert.equal(unres.status, 'UNRESOLVED'); assert.equal(unres.netR, null);
  const open = buildTrade(sig, openEntry, { status: 'UNRESOLVED', monitorTf: 'M5' }, def, { openAtEnd: true });
  assert.equal(open.status, 'OPEN');
  assert.equal(open.dataQuality.openAtDatasetEnd, true);
});

test('dedupKey is stable and pair/strategy/version/candle scoped', () => {
  assert.equal(dedupKey(sig), 'today|' + def.version + '|EUR_USD|1000');
  assert.notEqual(dedupKey(sig), dedupKey(Object.assign({}, sig, { entryCloseMs: 2000 })));
});
