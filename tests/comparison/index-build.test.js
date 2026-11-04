'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildIndices, idxAtOrBefore } = require('../../research/comparison/index-build');
const { CURRENCIES, PAIRS, M15_MS, BASE_VALUE } = require('../../research/comparison/config');

const START = Date.UTC(2025, 4, 1, 0, 0, 0);
// Build a SELF-CONSISTENT currency network from true values V_c(i); each stored pair's
// close = V_base/V_quote. The construction must then recover V_c relative to the basket.
function networkCandles(n, valueFns) {
  const V = {}; for (const c of CURRENCIES) { V[c] = []; for (let i = 0; i < n; i++) V[c].push(valueFns[c](i)); }
  const by = {};
  for (const p of PAIRS) { const [b, q] = p.split('_'); by[p] = []; for (let i = 0; i < n; i++) { const px = V[b][i] / V[q][i]; by[p].push({ openMs: START + i * M15_MS, open: px, high: px, low: px, close: px }); } }
  return { by, V };
}

test('known-answer: only AUD rises → index recovers the zero-sum relative values', () => {
  const n = 100, g = 0.0005;
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0; fns.AUD = (i) => Math.exp(g * i);
  const { by } = networkCandles(n, fns);
  const r = buildIndices(by);
  assert.ok(r.ok);
  const last = r.timeline.length - 1;
  // r_AUD = 7g/8 per step, r_other = −g/8 per step (derived from the 1/8 zero-sum construction)
  const expAud = BASE_VALUE * Math.exp(7 * g * last / 8);
  const expOther = BASE_VALUE * Math.exp(-g * last / 8);
  assert.ok(Math.abs(r.index.AUD[last] - expAud) < 1e-6, 'AUD index matches ' + r.index.AUD[last] + ' vs ' + expAud);
  assert.ok(Math.abs(r.index.USD[last] - expOther) < 1e-6, 'USD index matches');
  // zero-sum: Σ ln(index_c) = 8·ln(base) at every step
  for (let i = 0; i < r.timeline.length; i += 20) { let s = 0; for (const c of CURRENCIES) s += Math.log(r.index[c][i]); assert.ok(Math.abs(s - 8 * Math.log(BASE_VALUE)) < 1e-9, 'zero-sum holds at step ' + i); }
});

test('pair inversion: a currency as quote negates the log return (symmetry)', () => {
  const n = 60, g = 0.0008;
  // make JPY depreciate (V_JPY falls) → in USD_JPY (JPY quote) the pair RISES; JPY index must fall.
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0; fns.JPY = (i) => Math.exp(-g * i);
  const r = buildIndices(networkCandles(n, fns).by);
  const last = r.timeline.length - 1;
  assert.ok(r.index.JPY[last] < BASE_VALUE, 'JPY depreciates');
  // all others appreciate equally vs the basket
  assert.ok(r.index.USD[last] > BASE_VALUE && Math.abs(r.index.USD[last] - r.index.EUR[last]) < 1e-9);
});

test('flat network → every index stays at base', () => {
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.2345;
  const r = buildIndices(networkCandles(50, fns).by);
  for (const c of CURRENCIES) assert.ok(Math.abs(r.index[c][r.timeline.length - 1] - BASE_VALUE) < 1e-9);
});

test('synchronized timeline uses only times where ALL pairs are present (no basket change)', () => {
  const { by } = networkCandles(40, Object.fromEntries(CURRENCIES.map((c) => [c, () => 1])));
  by['EUR_USD'] = by['EUR_USD'].slice(0, 30);   // one pair missing the last 10 steps
  const r = buildIndices(by);
  assert.equal(r.ok, true);
  // timeline truncated to where all pairs exist
  assert.ok(r.lastMs <= START + 30 * M15_MS);
});

test('idxAtOrBefore returns the carry value at a boundary', () => {
  const r = buildIndices(networkCandles(50, Object.fromEntries(CURRENCIES.map((c) => [c, () => 1]))).by);
  const at = idxAtOrBefore(r, 'USD', START + 10 * M15_MS + 1);
  assert.ok(at && at.ms <= START + 10 * M15_MS + 1 && Math.abs(at.value - BASE_VALUE) < 1e-9);
});
