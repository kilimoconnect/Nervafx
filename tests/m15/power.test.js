'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateCurrencyPower, geomMeanWeighted } = require('../../api/_m15/power');
const { PAIRS, pipSize } = require('../../api/_m15/pairs');

const M = (velocity, acceleration = 0, efficiency = 0.9, consistency = 0.9) => ({ velocity, acceleration, efficiency, consistency });
const base = (fill) => Object.fromEntries(PAIRS.map((p) => [p, fill(p)]));

/** Make `ccy` advance broadly with quality `q`. */
function ccyAdvancing(ccy, { vel = 2, acc = 1, eff = 0.9, cons = 0.9 } = {}) {
  return base((p) => {
    const [b, q] = p.split('_');
    if (b === ccy) return M(vel, acc, eff, cons);      // base up ⇒ ccy up
    if (q === ccy) return M(-vel, -acc, eff, cons);    // quote, pair down ⇒ ccy up
    return M(0, 0, 0.5, 0.5);
  });
}

test('broad, efficient, accelerating currency ⇒ high power in the right direction', () => {
  const { byCurrency } = evaluateCurrencyPower(ccyAdvancing('USD'));
  const usd = byCurrency['USD'];
  assert.equal(usd.powerDirection, 'BULLISH');
  assert.ok(usd.powerScore > 60, `expected strong power, got ${usd.powerScore}`);
  assert.ok(['ACTIVE', 'STRONG'].includes(usd.powerState));
  assert.ok(usd.supportingPairs.length >= 6);
});

test('power ≠ strength: extreme move but inefficient + decelerating ⇒ not STRONG (§14)', () => {
  const strong = evaluateCurrencyPower(ccyAdvancing('USD', { vel: 3, acc: 1, eff: 0.9, cons: 0.9 })).byCurrency['USD'];
  const tired = evaluateCurrencyPower(ccyAdvancing('USD', { vel: 3, acc: -1.5, eff: 0.2, cons: 0.4 })).byCurrency['USD'];
  assert.ok(tired.powerScore < strong.powerScore);
  assert.ok(['DECLINING', 'EXHAUSTED', 'BUILDING'].includes(tired.powerState),
    `tired state was ${tired.powerState}`);
});

test('narrow participation ⇒ lower power than broad', () => {
  const broad = evaluateCurrencyPower(ccyAdvancing('USD')).byCurrency['USD'].powerScore;
  const narrow = base((p) => (p === 'EUR_USD' ? M(-2, -1) : M(0, 0, 0.5, 0.5))); // USD up via one pair only
  const nScore = evaluateCurrencyPower(narrow).byCurrency['USD'].powerScore;
  assert.ok(broad > nScore);
});

test('wider spreads reduce power (liquidity factor)', () => {
  const mv = ccyAdvancing('USD');
  const tight = evaluateCurrencyPower(mv, { spreads: Object.fromEntries(PAIRS.map((p) => [p, pipSize(p) * 0.5])) }).byCurrency['USD'].powerScore;
  const wide = evaluateCurrencyPower(mv, { spreads: Object.fromEntries(PAIRS.map((p) => [p, pipSize(p) * 6])) }).byCurrency['USD'].powerScore;
  assert.ok(tight > wide, `tight ${tight} should exceed wide ${wide}`);
});

test('geomMeanWeighted does not collapse balanced factors like a raw product', () => {
  const g = geomMeanWeighted({ a: 0.7, b: 0.7, c: 0.7, d: 0.7, e: 0.7 }, { a: 1, b: 1, c: 1, d: 1, e: 1 });
  assert.ok(Math.abs(g - 0.7) < 1e-9); // raw product would be 0.7^5 ≈ 0.168
});

test('deterministic', () => {
  const mv = ccyAdvancing('EUR');
  assert.deepEqual(evaluateCurrencyPower(mv), evaluateCurrencyPower(mv));
});
