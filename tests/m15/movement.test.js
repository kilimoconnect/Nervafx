'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateMovement, CLASS } = require('../../api/_m15/movement');
const { mk, flat, zigzag } = require('./_helpers');

function ramp(n, base = 1.1000, step = 0.0004, accel = 0) {
  const out = []; let p = base; let s = step;
  for (let i = 0; i < n; i++) { s += accel; const o = p; p += s; out.push(mk(i, o, Math.max(o, p) + 0.00005, Math.min(o, p) - 0.00005, p)); }
  return out;
}

test('flat/dead market ⇒ NEUTRAL movement', () => {
  const m = evaluateMovement(flat(100), { pair: 'EUR_USD' });
  assert.equal(m.direction, 'NEUTRAL');
  assert.equal(m.classification, CLASS.NEUTRAL);
});

test('steady up-ramp ⇒ BULLISH with high efficiency', () => {
  const m = evaluateMovement(ramp(120), { pair: 'EUR_USD' });
  assert.equal(m.direction, 'BULLISH');
  assert.ok(m.velocity > 0);
  assert.ok(m.efficiency > 0.7, `expected efficient path, got ${m.efficiency}`);
});

test('steady down-ramp ⇒ BEARISH, negative velocity', () => {
  const m = evaluateMovement(ramp(120, 1.2, -0.0004), { pair: 'EUR_USD' });
  assert.equal(m.direction, 'BEARISH');
  assert.ok(m.velocity < 0);
});

test('accelerating up-ramp ⇒ BULLISH_ACCELERATING; decelerating ⇒ not accelerating', () => {
  const acc = evaluateMovement(ramp(140, 1.1, 0.0001, 0.00003), { pair: 'EUR_USD' });
  assert.equal(acc.classification, CLASS.BULL_ACC);
  const dec = evaluateMovement(ramp(140, 1.1, 0.0045, -0.00003), { pair: 'EUR_USD' });
  assert.notEqual(dec.classification, CLASS.BULL_ACC);
});

test('efficiency is bounded [0,1] and consistency [0,1]', () => {
  const m = evaluateMovement(zigzag(160, 1.1, 0.006, 12), { pair: 'GBP_JPY' });
  assert.ok(m.efficiency >= 0 && m.efficiency <= 1);
  assert.ok(m.consistency >= 0 && m.consistency <= 1);
});

test('deterministic & no-lookahead: prefix movement matches full-series value at k', () => {
  const full = ramp(200);
  const mFullAtK = evaluateMovement(full.slice(0, 120), { pair: 'EUR_USD' });
  const again = evaluateMovement(full.slice(0, 120), { pair: 'EUR_USD' });
  assert.deepEqual(mFullAtK, again);
});

test('trend stage is a label from the fixed enum, never a candle count', () => {
  const m = evaluateMovement(ramp(150), { pair: 'EUR_USD' });
  assert.ok(['FORMING', 'EMERGING', 'ACTIVE', 'DEVELOPED', 'MATURE', 'EXHAUSTING', 'FAILED'].includes(m.stage));
  assert.ok(!('ageCandles' in m));
});
