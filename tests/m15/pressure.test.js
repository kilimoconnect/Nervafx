'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluatePressure } = require('../../api/_m15/pressure');
const { mk, flat } = require('./_helpers');

function trend(n, base = 1.1000, step = 0.0006) {
  const out = []; let p = base;
  for (let i = 0; i < n; i++) { const o = p; p += step; out.push(mk(i, o, Math.max(o, p) + 0.00003, Math.min(o, p) - 0.00003, p)); }
  return out;
}

test('steady uptrend ⇒ bullish pressure building/dominant', () => {
  const r = evaluatePressure(trend(120), { pair: 'EUR_USD' });
  assert.equal(r.pressureDirection, 'BULLISH');
  assert.ok(r.netPressure > 0.15);
  assert.ok(['BULLISH_BUILDING', 'BULLISH_DOMINANT', 'BULLISH_FORMING'].includes(r.pressureState));
});

test('steady downtrend ⇒ bearish pressure', () => {
  const r = evaluatePressure(trend(120, 1.2, -0.0006), { pair: 'EUR_USD' });
  assert.equal(r.pressureDirection, 'BEARISH');
  assert.ok(r.netPressure < -0.15);
});

test('dead-flat ⇒ BALANCED', () => {
  const r = evaluatePressure(flat(120), { pair: 'EUR_USD' });
  assert.equal(r.pressureState, 'BALANCED');
});

test('opposing evidence on both sides ⇒ CONFLICTED', () => {
  // Inject: strong selling velocity but strong accepted-above + upward migration
  // and up-leg dominance ⇒ high buying AND selling mass, ~0 net.
  // Two strong bearish signals (velocity, acceleration) vs two strong bullish
  // (acceptance, migration), leg dominance neutral ⇒ high mass both sides, net≈0.
  const r = evaluatePressure(trend(60), {
    pair: 'EUR_USD',
    movement: { velocity: -5, acceleration: -5 },
    eq: { acceptanceBias: 1, migrationVelocity: 0.5, distanceVol: 0 },
    structure: { legs: [{ direction: 'UP', displacement: 0.01 }, { direction: 'DOWN', displacement: 0.01 }], events: [] },
  });
  assert.equal(r.pressureState, 'CONFLICTED');
});

test('net = buying − selling masses reconcile with direction', () => {
  const r = evaluatePressure(trend(120), { pair: 'EUR_USD' });
  assert.ok(r.buyingPressure >= 0 && r.sellingPressure >= 0);
  assert.ok(Math.abs(r.netPressure - (r.buyingPressure - r.sellingPressure)) < 1e-6);
});

test('deterministic', () => {
  const c = trend(120);
  assert.deepEqual(evaluatePressure(c, { pair: 'EUR_USD' }), evaluatePressure(c, { pair: 'EUR_USD' }));
});
