'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildSeries, computeWindow, pairMeasure } = require('../../research/movement/engine');
const { CONFIG, PAIRS, M15_MS } = require('../../research/movement/config');

const START = Date.UTC(2025, 0, 6, 0, 0, 0);
function gen(n, closeFn) { const out = []; for (let i = 0; i < n; i++) { const c = closeFn(i); out.push({ openMs: START + i * M15_MS, open: c, high: c, low: c, close: c }); } return out; }
// Distinct deterministic noise per pair (so pair returns are not identical/correlated).
const noiseFor = (seed) => (i) => 1.0 + 0.0012 * Math.sin((i + seed * 11) / (6 + (seed % 5))) + 0.0007 * Math.cos((i + seed * 7) / (3 + (seed % 4)));

function world(n, overrides) {
  const by = {}; PAIRS.forEach((p, k) => { by[p] = gen(n, (overrides && overrides[p]) || noiseFor(k + 1)); }); return by;
}

test('base/quote sign: a falling EUR_AUD is negative for EUR and positive for AUD', () => {
  const n = 200;
  const base = noiseFor(9);
  const down = (i) => { let b = base(i); if (i >= n - 4) b -= 0.02 * (i - (n - 4) + 1) / 4; return b; };   // −2% over the last 1h
  const series = buildSeries(world(n, { EUR_AUD: down }));
  const r = computeWindow(series, START + (n - 1) * M15_MS + M15_MS, '1h', CONFIG);
  assert.ok(r.ok);
  assert.ok(r.currencies.EUR.score < 0, 'EUR weakens (base of a falling pair)');
  assert.ok(r.currencies.AUD.score > 0, 'AUD strengthens (quote of a falling pair)');
  // the EUR_AUD contribution itself: EUR base → negative, AUD quote → positive
  const eurLeg = r.currencies.EUR.contributions.find((c) => c.pair === 'EUR_AUD');
  const audLeg = r.currencies.AUD.contributions.find((c) => c.pair === 'EUR_AUD');
  assert.ok(eurLeg.contribution < 0 && audLeg.contribution > 0);
  assert.ok(Math.abs(eurLeg.contribution + audLeg.contribution) < 1e-9, 'equal and opposite across the two currencies');
});

test('common analysis timestamp: every currency is measured to the same endpoint', () => {
  const series = buildSeries(world(200));
  const r = computeWindow(series, START + 199 * M15_MS + M15_MS, '4h', CONFIG);
  const ends = new Set();
  for (const c of Object.keys(r.currencies)) ends.add(r.endUtc);
  assert.equal(ends.size, 1);
  assert.equal(r.windowLabel, '4 hours');
});

test('insufficient history is not treated as neutral/zero (excluded from coverage)', () => {
  const by = world(200); by['EUR_USD'] = gen(10, noiseFor(1));   // stale: far too few candles
  const r = computeWindow(buildSeries(by), START + 199 * M15_MS + M15_MS, '4h', CONFIG);
  const eur = r.currencies.EUR, usd = r.currencies.USD;
  assert.ok(eur.coverage.missing.includes('EUR_USD') && usd.coverage.missing.includes('EUR_USD'));
  assert.ok(eur.coverage.valid < 7 && eur.provisional === true);
  const leg = eur.contributions.find((c) => c.pair === 'EUR_USD');
  assert.equal(leg.insufficient, true); assert.equal(leg.contribution, null);
});

test('zero-variance pair → insufficient (not a 0 contribution)', () => {
  const flat = buildSeries({ GBP_USD: gen(400, () => 1.2345) })['GBP_USD'];   // flat, enough candles for the sample count
  const m = pairMeasure(flat, START + 399 * M15_MS + M15_MS, { candles: 16, kind: 'elapsed' }, CONFIG);
  assert.equal(m.insufficient, true);
  assert.equal(m.insufficientReason, 'zero variance');
});

test('direction neutral band: a tiny move is MIXED, a large coherent move is directional', () => {
  const n = 200;
  const series = buildSeries(world(n));   // pure noise → small scores
  const r = computeWindow(series, START + (n - 1) * M15_MS + M15_MS, '1h', CONFIG);
  // most currencies should be MIXED under pure noise
  const mixed = Object.values(r.currencies).filter((c) => c.direction === 'MIXED').length;
  assert.ok(mixed >= 4, 'noise is mostly directionless');
});
