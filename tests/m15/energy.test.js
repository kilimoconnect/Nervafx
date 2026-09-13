'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateEnergy } = require('../../api/_m15/energy');
const { mk, flat } = require('./_helpers');

/** Clean efficient trend: each candle steps up with a full body. */
function trend(n, base = 1.1000, step = 0.0006) {
  const out = []; let p = base;
  for (let i = 0; i < n; i++) { const o = p; p += step; out.push(mk(i, o, p + 0.00003, o - 0.00003, p)); }
  return out;
}
/** Chaotic: big ranges, near-zero net movement (whipsaw). */
function chaotic(n, base = 1.1000, amp = 0.0030) {
  const out = []; let p = base;
  for (let i = 0; i < n; i++) { const dir = i % 2 ? 1 : -1; const o = p; p = base + dir * amp * 0.15; out.push(mk(i, o, Math.max(o, p) + amp, Math.min(o, p) - amp, p)); }
  return out;
}

test('dead/flat market ⇒ DEAD or LOW energy, BALANCED direction', () => {
  const e = evaluateEnergy(flat(120), { pair: 'EUR_USD' });
  assert.ok(['DEAD', 'LOW'].includes(e.energyLevel), `got ${e.energyLevel}`);
  assert.equal(e.energyDirection, 'BALANCED');
});

test('a single large candle in a calm market does NOT produce STRONG energy (§16)', () => {
  const c = flat(120);
  const i = c.length - 1;
  // replace the last candle with one huge bar
  c[i] = mk(i, 1.1000, 1.1120, 1.0880, 1.1115);
  const e = evaluateEnergy(c, { pair: 'EUR_USD' });
  assert.ok(!['STRONG', 'EXPLOSIVE'].includes(e.energyLevel),
    `one big bar must not be STRONG, got ${e.energyLevel}`);
});

test('high volatility with poor efficiency ⇒ CHAOTIC direction (§32)', () => {
  const e = evaluateEnergy(chaotic(120), { pair: 'EUR_USD' });
  assert.ok(e.components.efficiency < 0.4, `efficiency should be poor, got ${e.components.efficiency}`);
  assert.equal(e.energyDirection, 'CHAOTIC');
});

test('clean efficient trend ⇒ directional (BULLISH) with good efficiency', () => {
  const e = evaluateEnergy(trend(120), { pair: 'EUR_USD' });
  assert.equal(e.energyDirection, 'BULLISH');
  assert.ok(e.components.efficiency > 0.6);
  assert.ok(e.energyScore > 30);
});

test('energy level and direction are independent fields', () => {
  const e = evaluateEnergy(trend(120), { pair: 'EUR_USD' });
  assert.ok(typeof e.energyScore === 'number');
  assert.ok(['DEAD', 'LOW', 'BUILDING', 'ACTIVE', 'STRONG', 'EXPLOSIVE'].includes(e.energyLevel));
  assert.ok(['BULLISH', 'BEARISH', 'BALANCED', 'CHAOTIC'].includes(e.energyDirection));
});

test('deterministic', () => {
  const c = trend(80);
  assert.deepEqual(evaluateEnergy(c, { pair: 'EUR_USD' }), evaluateEnergy(c, { pair: 'EUR_USD' }));
});
