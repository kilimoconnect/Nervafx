'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { rankedPairs, alertablePairs } = require('../../research/flow/ranking');

// Build a panel per currency. Direction comes from the CURRENT Renko brick (finalDir): up = green/buy,
// down = red/sell. lastPp is the index value in pp — it only sizes the strength gap, not direction.
function panel(currency, lastPp, finalDir) {
  return { currency, available: true, lastPp, finalDir };
}

// EUR/GBP/CHF/AUD are green (up); USD/JPY/CAD/NZD are red (down).
function baseScenario() {
  return [
    panel('EUR', 1.00, 'up'),
    panel('USD', -1.00, 'down'),
    panel('GBP', 0.50, 'up'),
    panel('JPY', -0.20, 'down'),
    panel('CHF', 0.10, 'up'),
    panel('CAD', 0.40, 'down'),
    panel('AUD', 0.30, 'up'),
    panel('NZD', -0.30, 'down'),
  ];
}

test('a pair ranks only when its two currencies point OPPOSITE ways on the brick', () => {
  const rows = rankedPairs(baseScenario(), {}, {});
  const byPair = Object.fromEntries(rows.map((r) => [r.pair, r]));
  // EUR up, USD down → opposite → present, lean up (buy EUR, sell USD)
  assert.ok(byPair.EUR_USD, 'EUR_USD present');
  assert.strictEqual(byPair.EUR_USD.leanUp, true);
  assert.strictEqual(byPair.EUR_USD.dir, 'up');
  assert.strictEqual(byPair.EUR_USD.strong, 'EUR');  // green = bought
  assert.strictEqual(byPair.EUR_USD.weak, 'USD');    // red = sold
  // EUR up, GBP up → same brick direction → dropped
  assert.ok(!byPair.EUR_GBP, 'EUR_GBP (both green) dropped');
});

test('lean follows the brick even when the base is red (sell the pair)', () => {
  const rows = rankedPairs(baseScenario(), {}, {});
  const uc = rows.find((r) => r.pair === 'USD_CHF');  // USD down (base), CHF up (quote)
  assert.ok(uc, 'USD_CHF present (opposite bricks)');
  assert.strictEqual(uc.leanUp, false);   // base red → sell the pair
  assert.strictEqual(uc.dir, 'down');
  assert.strictEqual(uc.strong, 'CHF');   // green = bought
  assert.strictEqual(uc.weak, 'USD');     // red = sold
});

test('rows are ordered by the pp strength gap (descending)', () => {
  const rows = rankedPairs(baseScenario(), {}, {});
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].spread >= rows[i].spread, 'sorted by spread desc');
  }
  const eu = rows.find((r) => r.pair === 'EUR_USD');
  assert.ok(Math.abs(eu.spread - 2.0) < 1e-9, 'EUR_USD gap = |1.00 − (−1.00)| = 2.00');
});

test('a currency with no brick (finalDir null) contributes no pairs', () => {
  const panels = baseScenario().map((p) => (p.currency === 'EUR' ? panel('EUR', 1.0, null) : p));
  const rows = rankedPairs(panels, {}, {});
  assert.ok(!rows.some((r) => r.pair.startsWith('EUR_') || r.pair.endsWith('_EUR')), 'no EUR pairs without a brick');
});

test('alertablePairs requires opposite-brick, aligned, and in-direction BoS', () => {
  const panels = baseScenario();
  const structures = {
    EUR_USD: 'up',    // agrees with the up lean → aligned
    AUD_USD: 'down',  // disagrees with AUD_USD's up lean → NOT aligned
    USD_CHF: 'down',  // agrees with USD_CHF's down lean → aligned, but no BoS set below
  };
  const bos = {
    EUR_USD: 'up',    // in lean direction → fires
    AUD_USD: 'up',    // present but the pair is not aligned → excluded
  };
  const alerts = alertablePairs(panels, structures, bos);
  const pairs = alerts.map((a) => a.pair);
  assert.ok(pairs.includes('EUR_USD'), 'EUR_USD aligned with an up BoS');
  assert.ok(!pairs.includes('AUD_USD'), 'AUD_USD structure contradicts its lean → not aligned');
  assert.ok(!pairs.includes('USD_CHF'), 'USD_CHF has no BoS');
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

test('fewer than two directional currencies → no rows', () => {
  assert.deepStrictEqual(rankedPairs([panel('EUR', 1.0, 'up')], {}, {}), []);
  // a currency present but without a brick is not counted
  assert.deepStrictEqual(rankedPairs([panel('EUR', 1.0, 'up'), panel('USD', -1.0, null)], {}, {}), []);
});
