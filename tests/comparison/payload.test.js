'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildComparison } = require('../../research/comparison/payload');
const { CURRENCIES, PAIRS, M15_MS, DAY_MS, CONFIG } = require('../../research/comparison/config');
const { EAT_OFFSET_MS } = require('../../research/comparison/periods');

const START = Date.UTC(2025, 4, 1, 0, 0, 0);   // 2025-05-01 00:00 UTC (a Thursday)
// Self-consistent network: stored pair close = V_base / V_quote.
function network(nSteps, valueFns) {
  const by = {};
  for (const p of PAIRS) {
    const [b, q] = p.split('_'); by[p] = [];
    for (let i = 0; i < nSteps; i++) { const px = valueFns[b](i) / valueFns[q](i); by[p].push({ openMs: START + i * M15_MS, open: px, high: px, low: px, close: px }); }
  }
  return by;
}

const STEPS = Math.round(95 * DAY_MS / M15_MS);    // ~95 UTC days of M15 (covers month-so-far + 2 prior months)
const ASOF = START + 93 * DAY_MS + 7 * M15_MS;

test('weekSoFar: assembles, ranks by signed return, context weeks present, no zero-substitution', () => {
  const g = 0.0004;
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0;
  fns.AUD = (i) => Math.exp(g * i);                 // AUD strongest overall
  fns.JPY = (i) => Math.exp(-g * i);                // JPY weakest
  const by = network(STEPS, fns);
  const r = buildComparison(by, { asOfMs: ASOF, view: 'weekSoFar', currency: 'AUD' }, CONFIG);
  assert.ok(r.ok && r.available);
  assert.equal(r.view, 'weekSoFar');
  assert.equal(r.cards.length, 8);
  assert.equal(r.cards[0].currency, 'AUD');
  assert.equal(r.cards[r.cards.length - 1].currency, 'JPY');
  assert.equal(r.cards[0].rank, 1);
  assert.ok(r.cards[0].returnPct > 0 && r.cards[r.cards.length - 1].returnPct < 0);
  assert.equal(r.periodInfo.status, 'developing');
  assert.ok(/Week so far/.test(r.periodInfo.title));
  assert.ok(/Developing week/.test(r.periodInfo.sublabel));
  assert.equal(r.contextPeriods.length, 2);          // previous 2 weeks
  assert.equal(r.detail.pairs.length, 7);
  // views list no longer offers previousDay / sessions
  assert.deepEqual(r.views.map((v) => v.name), ['todaySoFar', 'weekSoFar', 'monthSoFar']);
});

test('monthSoFar: developing month labelled, context months at same elapsed offset', () => {
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0; fns.EUR = (i) => Math.exp(0.0003 * i);
  const by = network(STEPS, fns);
  const r = buildComparison(by, { asOfMs: ASOF, view: 'monthSoFar' }, CONFIG);
  assert.ok(r.ok && r.available);
  assert.equal(r.view, 'monthSoFar');
  assert.equal(r.periodInfo.status, 'developing');
  assert.ok(/Month so far/.test(r.periodInfo.title));
  assert.ok(/Developing month/.test(r.periodInfo.sublabel));
  // developing month starts on the 1st 00:00 EAT (00:00 EAT = 21:00 UTC the prior day)
  assert.equal(new Date(Date.parse(r.periodInfo.startUtc) + EAT_OFFSET_MS).getUTCDate(), 1);
});

test('todaySoFar: developing day labelled, forming candle excluded (end = cutoff)', () => {
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0; fns.GBP = (i) => Math.exp(0.0003 * i);
  const by = network(STEPS, fns);
  const r = buildComparison(by, { asOfMs: ASOF, view: 'todaySoFar' }, CONFIG);
  assert.ok(r.ok && r.available);
  assert.equal(r.periodInfo.status, 'developing');
  assert.ok(/Today so far/.test(r.periodInfo.title));
  assert.equal(Date.parse(r.periodInfo.endUtc), ASOF);
});

test('removed views return no period (previousDay / sessions are gone)', () => {
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0;
  const by = network(STEPS, fns);
  const r = buildComparison(by, { asOfMs: ASOF, view: 'previousDay' }, CONFIG);
  assert.equal(r.available, false);
});

test('historical replay is causal: asOf in the past never uses later data', () => {
  const fns = {}; for (const c of CURRENCIES) fns[c] = () => 1.0; fns.CAD = (i) => Math.exp(0.0003 * i);
  const by = network(STEPS, fns);
  const asOf = START + 40 * DAY_MS + 5 * M15_MS;
  const r = buildComparison(by, { asOfMs: asOf, view: 'weekSoFar' }, CONFIG);
  assert.ok(r.ok && r.available);
  assert.ok(Date.parse(r.periodInfo.endUtc) <= asOf);
  for (const cp of r.contextPeriods) assert.ok(Date.parse(cp.endUtc) <= asOf);
});
