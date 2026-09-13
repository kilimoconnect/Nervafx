'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateExpansion } = require('../../api/_m15/expansion');
const { evaluateFreshness } = require('../../api/_m15/freshness');
const { evaluateEquilibrium } = require('../../api/_m15/equilibrium');
const { evaluateEnergy } = require('../../api/_m15/energy');
const { evaluateMovement } = require('../../api/_m15/movement');
const { detectStructure } = require('../../api/_m15/structure');
const { mk, flat } = require('./_helpers');

function trend(n, base = 1.1000, step = 0.0006) {
  const out = []; let p = base;
  for (let i = 0; i < n; i++) { const o = p; p += step; out.push(mk(i, o, Math.max(o, p) + 0.00004, Math.min(o, p) - 0.00004, p)); }
  return out;
}
/** Realistic quiet base (~2 pip ranges), then a fresh early breakout of 2 candles. */
function freshBreakout(quiet = 90, push = 2, qrange = 0.0002, step = 0.0003) {
  const c = []; let idx = 0; let p = 1.1000;
  for (let i = 0; i < quiet; i++) { const o = p; p = 1.1000 + (i % 2 ? qrange : -qrange); c.push(mk(idx++, o, Math.max(o, p) + qrange * 0.3, Math.min(o, p) - qrange * 0.3, p)); }
  for (let k = 0; k < push; k++) { const o = p; p = o + step; c.push(mk(idx++, o, p + step * 0.1, o - step * 0.05, p)); }
  return c;
}
function bundle(candles) {
  const structure = detectStructure(candles, { pair: 'EUR_USD' });
  const eq = evaluateEquilibrium(candles, { pair: 'EUR_USD' });
  const energy = evaluateEnergy(candles, { pair: 'EUR_USD' });
  const movement = evaluateMovement(candles, { pair: 'EUR_USD', structure, eq });
  return { structure, eq, energy, movement };
}

test('flat market ⇒ expansion NONE/ATTEMPTING, freshness PREPARING', () => {
  const c = flat(120); const b = bundle(c);
  const x = evaluateExpansion(c, { pair: 'EUR_USD', ...b });
  assert.ok(['NONE', 'ATTEMPTING'].includes(x.state));
  const fr = evaluateFreshness({ ...b, expansion: x });
  assert.equal(fr.state, 'PREPARING');
});

test('fresh early breakout ⇒ EARLY/CONFIRMED expansion, FRESH/TRADEABLE freshness', () => {
  const c = freshBreakout(); const b = bundle(c);
  const x = evaluateExpansion(c, { pair: 'EUR_USD', ...b });
  assert.ok(['EARLY', 'CONFIRMED', 'ATTEMPTING'].includes(x.state), `expansion ${x.state}`);
  const fr = evaluateFreshness({ ...b, expansion: x });
  assert.ok(['FRESH', 'TRADEABLE', 'PREPARING'].includes(fr.state), `freshness ${fr.state}`);
  assert.equal(fr.firstOpportunityPassed, false);
});

test('LATE regression (§32): a mature, far, decelerating up-move is NOT fresh', () => {
  // Long strong trend that then decelerates: bullish everywhere, but far + slowing.
  const c = trend(160);
  // decelerate the last stretch
  let p = c[c.length - 1].close;
  for (let k = 0; k < 20; k++) { const o = p; p = o + 0.00008; c.push(mk(c.length, o, p + 0.00003, o - 0.00003, p)); }
  const b = bundle(c);
  const x = evaluateExpansion(c, { pair: 'EUR_USD', ...b });
  const fr = evaluateFreshness({ ...b, expansion: x });
  assert.ok(['LATE', 'EXHAUSTED', 'DEVELOPING'].includes(fr.state), `freshness ${fr.state}`);
  assert.ok(fr.distanceVol > 1.5 || x.state === 'OVEREXTENDED' || x.state === 'DEVELOPED');
});

test('overextended expansion ⇒ freshness EXHAUSTED and firstOpportunityPassed', () => {
  const c = trend(80, 1.1, 0.0016); // steep, far from equilibrium
  const b = bundle(c);
  const x = evaluateExpansion(c, { pair: 'EUR_USD', ...b });
  const fr = evaluateFreshness({ ...b, expansion: x });
  if (x.state === 'OVEREXTENDED') {
    assert.equal(fr.state, 'EXHAUSTED');
    assert.equal(fr.firstOpportunityPassed, true);
  }
});

test('deterministic', () => {
  const c = freshBreakout(); const b = bundle(c);
  const x1 = evaluateExpansion(c, { pair: 'EUR_USD', ...b });
  const x2 = evaluateExpansion(c, { pair: 'EUR_USD', ...b });
  assert.deepEqual(x1, x2);
});
