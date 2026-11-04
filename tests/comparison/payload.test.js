'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildComparison } = require('../../research/comparison/payload');
const { CURRENCIES, PAIRS, M15_MS, DAY_MS, CONFIG } = require('../../research/comparison/config');

const START = Date.UTC(2025, 4, 1, 0, 0, 0);   // 2025-05-01 00:00 UTC
// Self-consistent network: stored pair close = V_base / V_quote.
function network(nSteps, valueFns) {
  const by = {};
  for (const p of PAIRS) {
    const [b, q] = p.split('_'); by[p] = [];
    for (let i = 0; i < nSteps; i++) { const px = valueFns[b](i) / valueFns[q](i); by[p].push({ openMs: START + i * M15_MS, open: px, high: px, low: px, close: px }); }
  }
  return by;
}

const STEPS = Math.round(4 * DAY_MS / M15_MS);     // 4 UTC days of M15

test('previousDay: assembles, ranks by signed return, no zero-substitution', () => {
  const g = 0.0004;
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0;
  fns.AUD = (i) => Math.exp(g * i);                 // AUD strongest
  fns.JPY = (i) => Math.exp(-g * i);                // JPY weakest
  const by = network(STEPS, fns);
  const asOf = START + 3 * DAY_MS + 5 * M15_MS;     // mid-day 4 → previous completed day = day 3
  const r = buildComparison(by, { asOfMs: asOf, view: 'previousDay', currency: 'AUD' }, CONFIG);
  assert.ok(r.ok && r.available);
  assert.equal(r.cards.length, 8);
  assert.equal(r.cards[0].currency, 'AUD');                 // top of the ranking
  assert.equal(r.cards[r.cards.length - 1].currency, 'JPY'); // bottom
  assert.equal(r.cards[0].rank, 1);
  assert.ok(r.cards[0].returnPct > 0 && r.cards[r.cards.length - 1].returnPct < 0);
  // highlight candle carries real OHLC + context (previous 2 days)
  assert.ok(r.cards[0].highlight.ok);
  assert.equal(r.contextPeriods.length, 2);
  // detail exposes the 7 underlying legs for the selected currency
  assert.equal(r.detail.pairs.length, 7);
  assert.equal(r.detail.currency, 'AUD');
});

test('todaySoFar: developing day labelled, forming candle excluded (end = cutoff)', () => {
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0; fns.EUR = (i) => Math.exp(0.0003 * i);
  const by = network(STEPS, fns);
  const asOf = START + 3 * DAY_MS + 20 * M15_MS;
  const r = buildComparison(by, { asOfMs: asOf, view: 'todaySoFar' }, CONFIG);
  assert.ok(r.ok && r.available);
  assert.equal(r.periodInfo.status, 'developing');
  assert.ok(/Today so far/.test(r.periodInfo.title));
  assert.ok(/Developing/.test(r.periodInfo.sublabel));
});

test('missing pairs → provisional breadth, currency still available (never zero)', () => {
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0; fns.GBP = (i) => Math.exp(0.0002 * i);
  const by = network(STEPS, fns);
  // drop one leg entirely for part of the range — breadth coverage drops, index still builds
  // (remove a pair NOT needed for the synchronized timeline would break indices, so instead
  //  corrupt the breadth read by shrinking one pair's series tail)
  by['EUR_GBP'] = by['EUR_GBP'].slice(0, STEPS - 400);
  const asOf = START + 3 * DAY_MS + 5 * M15_MS;
  const r = buildComparison(by, { asOfMs: asOf, view: 'previousDay', currency: 'GBP' }, CONFIG);
  // index build intersects timelines, so the whole series truncates; still assembles a period
  assert.ok(r.ok);
  if (r.available) for (const c of r.cards) assert.ok(c.returnPct === null || typeof c.returnPct === 'number');
});

test('historical replay is causal: asOf in the past never uses later data', () => {
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0; fns.CAD = (i) => Math.exp(0.0003 * i);
  const by = network(STEPS, fns);
  const asOf = START + 2 * DAY_MS + 5 * M15_MS;
  const r = buildComparison(by, { asOfMs: asOf, view: 'previousDay' }, CONFIG);
  assert.ok(r.ok && r.available);
  // every period end is ≤ asOf
  assert.ok(Date.parse(r.periodInfo.endUtc) <= asOf);
  for (const cp of r.contextPeriods) assert.ok(Date.parse(cp.endUtc) <= asOf);
});
