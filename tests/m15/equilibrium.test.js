'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateEquilibrium, freezeBoundary, emaPair } = require('../../api/_m15/equilibrium');
const { mk, zigzag } = require('./_helpers');

/** A steady upward ramp of `n` candles. */
function ramp(n, base = 1.1000, step = 0.0003) {
  const out = [];
  let p = base;
  for (let i = 0; i < n; i++) { const o = p; p += step; out.push(mk(i, o, Math.max(o, p) + 0.0001, Math.min(o, p) - 0.0001, p)); }
  return out;
}

test('equilibrium lags price (slow adaptive baseline, not instantaneous §11)', () => {
  const c = ramp(120);
  const eq = evaluateEquilibrium(c, { pair: 'EUR_USD' });
  const first = c[0].close, last = c[c.length - 1].close;
  assert.ok(eq.equilibrium > first && eq.equilibrium < last,
    'equilibrium sits between the start and the current price on a ramp');
});

test('acceptance band brackets the equilibrium: lower < eq < upper', () => {
  const eq = evaluateEquilibrium(zigzag(120), { pair: 'EUR_USD' });
  assert.ok(eq.lowerAcceptance < eq.equilibrium);
  assert.ok(eq.upperAcceptance > eq.equilibrium);
});

test('upward ramp ⇒ price accepted above equilibrium and migration UP', () => {
  const eq = evaluateEquilibrium(ramp(150), { pair: 'EUR_USD' });
  assert.ok(eq.acceptanceAbove > eq.acceptanceBelow);
  assert.equal(eq.migrationDirection, 'UP');
  assert.ok(eq.distance > 0);
});

test('a frozen boundary is immutable and cannot be moved after expansion (§11)', () => {
  const eq = evaluateEquilibrium(zigzag(120), { pair: 'EUR_USD' });
  const b = freezeBoundary(eq, 'COMPRESSION', 'm15-cfg-1.0.0');
  assert.equal(Object.isFrozen(b), true);
  const before = b.upper_price;
  try { b.upper_price = before + 1; } catch (_) { /* strict mode throw is fine */ }
  assert.equal(b.upper_price, before, 'frozen boundary price never changes');
  assert.ok(b.lower_price < b.equilibrium_price && b.equilibrium_price < b.upper_price);
});

test('NO LOOK-AHEAD: equilibrium at index k is identical on a prefix vs the full series', () => {
  const full = zigzag(200);
  const eqFull = evaluateEquilibrium(full, { pair: 'EUR_USD' });
  const k = 120;
  const eqPre = evaluateEquilibrium(full.slice(0, k), { pair: 'EUR_USD' });
  assert.ok(Math.abs(eqPre.equilibrium - eqFull.eqSeries[k - 1]) < 1e-12);
});

test('reproducible: same candles ⇒ same equilibrium snapshot', () => {
  const c = zigzag(120);
  const a = evaluateEquilibrium(c, { pair: 'EUR_USD' });
  const b = evaluateEquilibrium(c, { pair: 'EUR_USD' });
  assert.equal(a.equilibrium, b.equilibrium);
  assert.equal(a.upperAcceptance, b.upperAcceptance);
});

test('emaPair returns EMA20/EMA50 series of the right length (§17 inputs)', () => {
  const c = zigzag(80);
  const { ema20, ema50 } = emaPair(c);
  assert.equal(ema20.length, c.length);
  assert.equal(ema50.length, c.length);
});
