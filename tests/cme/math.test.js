'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { pairLogReturn, solveCurrencySystem, signedContribution, solveLinear } = require('../../api/_cme-math');
const { CURRENCIES, PAIRS } = require('../../api/_cme-constants');

test('pairLogReturn: sign encodes base strength', () => {
  assert.ok(pairLogReturn(1.1000, 1.1055) > 0);   // base strengthened
  assert.ok(pairLogReturn(1.1000, 1.0950) < 0);   // base weakened
  assert.equal(pairLogReturn(0, 1), null);        // guarded
});

test('solveLinear solves a small system', () => {
  const x = solveLinear([[2, 1], [1, 3]], [5, 10]); // 2x+y=5, x+3y=10 → x=1,y=3
  assert.ok(Math.abs(x[0] - 1) < 1e-9 && Math.abs(x[1] - 3) < 1e-9);
});

test('decomposition recovers consistent movements and enforces Σ=0', () => {
  // Pick true movements (already sum-zero) and synthesise perfectly consistent returns.
  const truth = { USD: 0.002, EUR: -0.001, GBP: 0.0015, JPY: -0.003, CHF: 0.0005, CAD: 0.001, AUD: -0.0008, NZD: -0.0002 };
  const s = CURRENCIES.reduce((a, c) => a + truth[c], 0);
  CURRENCIES.forEach((c) => { truth[c] -= s / CURRENCIES.length; }); // force exact Σ=0
  const returns = {};
  for (const p of PAIRS) { const [b, q] = p.split('_'); returns[p] = truth[b] - truth[q]; }

  const sol = solveCurrencySystem(returns);
  assert.equal(sol.pairsUsed, 28);
  const sum = CURRENCIES.reduce((a, c) => a + sol.movement[c], 0);
  assert.ok(Math.abs(sum) < 1e-9, 'currency movements sum to zero');
  for (const c of CURRENCIES) assert.ok(Math.abs(sol.movement[c] - truth[c]) < 1e-9, c + ' recovered');
  assert.ok(sol.ssr < 1e-18, 'zero residual for consistent data');
});

test('decomposition is robust to a missing (failed) pair', () => {
  const truth = { USD: 0.001, EUR: 0.0, GBP: 0.0, JPY: -0.002, CHF: 0.0, CAD: 0.0, AUD: 0.0, NZD: 0.001 };
  const returns = {};
  for (const p of PAIRS) { if (p === 'EUR_USD') continue; const [b, q] = p.split('_'); returns[p] = truth[b] - truth[q]; }
  const sol = solveCurrencySystem(returns);
  assert.equal(sol.pairsUsed, 27);
  assert.ok(Math.abs(CURRENCIES.reduce((a, c) => a + sol.movement[c], 0)) < 1e-9);
  // still recovers (the graph stays connected with 27 of 28 edges)
  for (const c of CURRENCIES) assert.ok(Math.abs(sol.movement[c] - truth[c]) < 1e-8, c);
});

test('signedContribution orients base +, quote −', () => {
  assert.equal(signedContribution('EUR_USD', 0.01, 'EUR'), 0.01);
  assert.equal(signedContribution('EUR_USD', 0.01, 'USD'), -0.01);
  assert.equal(signedContribution('EUR_USD', 0.01, 'GBP'), 0);
});

test('each currency participates in exactly seven pairs', () => {
  for (const c of CURRENCIES) {
    const n = PAIRS.filter((p) => p.split('_')[0] === c || p.split('_')[1] === c).length;
    assert.equal(n, 7, c);
  }
});
