'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { contradictSet, rankedPairs, alertablePairs } = require('../../research/flow/ranking');

// Build a panel per currency with a strength (pp) and Renko direction.
function panel(currency, lastPp, finalDir) {
  return { currency, available: true, lastPp, finalDir };
}

// A scenario where EUR is strong+rising and USD is weak+falling, so EUR_USD leans up.
// GBP is weak+falling (same side as USD), CAD is strong-but-FALLING (contradiction).
function baseScenario() {
  const panels = [
    panel('EUR', 1.00, 'up'),
    panel('USD', -1.00, 'down'),
    panel('GBP', -0.50, 'down'),
    panel('JPY', -0.20, 'down'),
    panel('CHF', 0.10, 'up'),
    panel('CAD', 0.40, 'down'),   // strong (pp>0) but Renko down → contradiction
    panel('AUD', 0.30, 'up'),
    panel('NZD', -0.30, 'down'),
  ];
  return panels;
}

test('contradictSet flags strong-but-falling / weak-but-rising currencies only', () => {
  const bad = contradictSet(baseScenario());
  assert.deepStrictEqual(bad, { CAD: true });
});

test('alertablePairs requires contradiction-free, opposite-side, aligned, and in-direction BoS', () => {
  const panels = baseScenario();
  const structures = {
    EUR_USD: 'up',    // agrees with up lean → aligned
    AUD_USD: 'down',  // disagrees with up lean → NOT aligned
    EUR_CHF: 'up',    // aligned, but no BoS set below
  };
  const bos = {
    EUR_USD: 'up',    // in lean direction → fires
    AUD_USD: 'up',    // present but pair not aligned → excluded
    // EUR_CHF: no BoS → excluded
  };
  const alerts = alertablePairs(panels, structures, bos);
  const pairs = alerts.map((a) => a.pair);
  assert.ok(pairs.includes('EUR_USD'), 'EUR_USD is aligned with an up BoS');
  assert.ok(!pairs.includes('AUD_USD'), 'AUD_USD structure contradicts the lean → not aligned');
  assert.ok(!pairs.includes('EUR_CHF'), 'EUR_CHF has no BoS');
  const eu = alerts.find((a) => a.pair === 'EUR_USD');
  assert.strictEqual(eu.direction, 'up');
  assert.strictEqual(eu.strong, 'EUR');
  assert.strictEqual(eu.weak, 'USD');
});

test('BoS against the lean direction does not fire', () => {
  const panels = baseScenario();
  const structures = { EUR_USD: 'up' };
  const bos = { EUR_USD: 'down' }; // down BoS but the pair leans up → excluded
  assert.strictEqual(alertablePairs(panels, structures, bos).length, 0);
});

test('same-side pairs (both strong or both weak) are dropped before alignment', () => {
  const panels = baseScenario();
  // GBP_USD: GBP -0.50 and USD -1.00 are both weak → same side → never ranked
  const rows = rankedPairs(panels, { GBP_USD: 'down' }, { GBP_USD: 'down' });
  assert.ok(!rows.some((r) => r.pair === 'GBP_USD'), 'same-side pair excluded');
});

test('pairs touching a contradiction currency are dropped', () => {
  const panels = baseScenario();
  // Any CAD pair (e.g. EUR_CAD) must be absent because CAD contradicts.
  const rows = rankedPairs(panels, {}, {});
  assert.ok(!rows.some((r) => r.pair.includes('CAD')), 'no CAD pairs survive the contradiction filter');
});

test('fewer than two available currencies → no rows', () => {
  assert.deepStrictEqual(rankedPairs([panel('EUR', 1.0, 'up')], {}, {}), []);
});
