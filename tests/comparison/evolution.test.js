'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildIndices } = require('../../research/comparison/index-build');
const { liveEvolution, historyScan } = require('../../research/comparison/evolution');
const { dayStart } = require('../../research/comparison/periods');
const { PAIRS, M15_MS } = require('../../research/comparison/config');

// EAT midnight (00:00 EAT = 21:00 UTC the prior day); [START, START+DAY) is one EAT day.
const START = Date.UTC(2025, 4, 1, 21, 0, 0);
const DAY = 24 * 60 * 60 * 1000, STEPS_DAY = DAY / M15_MS;
const PRE = 12;                               // candles before midnight → anchors the day open
const DATA_START = START - PRE * M15_MS;

// Value network: pair close = V_base / V_quote. Only EUR moves → EUR index rises +7g/8 per step,
// every other currency falls −g/8 per step (zero-sum). gForTime(ms) sets the per-step growth.
function network(nSteps, gForTime) {
  const by = {}; for (const p of PAIRS) by[p] = [];
  let G = 0;
  for (let i = 0; i < nSteps; i++) {
    const t = DATA_START + i * M15_MS;
    if (i > 0) G += gForTime(t);
    const V = { EUR: Math.exp(G) };
    const val = (c) => (V[c] != null ? V[c] : 1);
    for (const p of PAIRS) { const [b, q] = p.split('_'); const px = val(b) / val(q); by[p].push({ openMs: t, open: px, high: px, low: px, close: px }); }
  }
  return by;
}

test('liveEvolution: a rising currency crosses +0.25% (reachedUp, state above); mirror reaches down', () => {
  const by = network(PRE + STEPS_DAY + 1, () => 0.0003);   // steady EUR growth
  const built = buildIndices(by);
  assert.ok(built.ok);
  const asOf = START + (STEPS_DAY - 1) * M15_MS;           // within the developing day
  const ev = liveEvolution(built, asOf, built.lastMs, 0.25);

  assert.equal(ev.startMs, dayStart(asOf));
  const eur = ev.rows.find((r) => r.currency === 'EUR');
  assert.ok(eur.reachedUp, 'EUR peak crossed +0.25%');
  assert.equal(eur.reachedDown, false);
  assert.equal(eur.state, 'above');
  assert.ok(eur.current > 0.25 && eur.peak >= eur.current);
  assert.equal(eur.rank, 1, 'EUR ranks first by current %');
  assert.ok(eur.firstUpMs != null && eur.firstUpMs <= asOf);

  const usd = ev.rows.find((r) => r.currency === 'USD');
  assert.ok(usd.reachedDown, 'USD (quote vs EUR) crossed −0.25%');
  assert.equal(usd.state, 'below');
  assert.ok(usd.current < 0);
});

test('threshold respected: a near-flat day crosses nothing', () => {
  const by = network(PRE + STEPS_DAY + 1, () => 0.000001);
  const built = buildIndices(by);
  const asOf = START + (STEPS_DAY - 1) * M15_MS;
  const ev = liveEvolution(built, asOf, built.lastMs, 0.25);
  for (const r of ev.rows) {
    assert.equal(r.reachedEither, false, r.currency + ' should not cross ±0.25% on a flat day');
    assert.equal(r.state, 'within');
  }
});

test('spread/watch onset: qualifies only when a leader passes ±0.25% AND the gap opens', () => {
  const by = network(PRE + STEPS_DAY + 1, () => 0.0003);   // EUR up, others down → wide spread
  const built = buildIndices(by);
  const asOf = START + (STEPS_DAY - 1) * M15_MS;
  const ev = liveEvolution(built, asOf, built.lastMs, 0.25, 0.30);
  const sp = ev.spread;
  assert.ok(sp.watchMs != null, 'watch onset detected');
  assert.equal(sp.state, 'watching');
  assert.ok(sp.max >= 0.30);
  const onset = sp.series.find((p) => p.ms === sp.watchMs);
  assert.ok(onset.spread >= 0.30 - 1e-9, 'gap at onset reaches the spread threshold');
  assert.ok(onset.top >= 0.25 || onset.bottom <= -0.25, 'a currency is beyond ±0.25% at onset');
  assert.ok(sp.watchMinutes >= 0);
});

test('spread does NOT qualify on a flat day (no leader crosses ±0.25%)', () => {
  const by = network(PRE + STEPS_DAY + 1, () => 0.000001);
  const built = buildIndices(by);
  const asOf = START + (STEPS_DAY - 1) * M15_MS;
  const sp = liveEvolution(built, asOf, built.lastMs, 0.25, 0.30).spread;
  assert.equal(sp.watchMs, null);
  assert.equal(sp.state, 'bunched');
});

test('historyScan: counts per-currency days reaching ±0.25% across EAT days', () => {
  // 3 EAT days of EUR movement: big / tiny / big (pre-midnight candles only anchor the open).
  const g = (t) => { const day = Math.floor((t - START) / DAY); return (day === 1) ? 0.000001 : 0.0003; };
  const by = network(PRE + 3 * STEPS_DAY + 1, g);
  const built = buildIndices(by);
  const asOf = START + (3 * STEPS_DAY - 1) * M15_MS;
  const h = historyScan(built, asOf, built.lastMs, { threshold: 0.25 });

  assert.equal(h.perCurrency.length, 8);
  assert.equal(h.daysScanned, 3, 'three full EAT days with data');
  const eur = h.perCurrency.find((x) => x.currency === 'EUR');
  assert.equal(eur.daysUp, 2, 'EUR reached +0.25% on the two big days only');
  assert.equal(eur.daysDown, 0);
  const usd = h.perCurrency.find((x) => x.currency === 'USD');
  assert.equal(usd.daysDown, 2, 'USD reached −0.25% on the two big days');
  assert.ok(h.matrix.length >= 3);
  assert.equal(h.matrix[0].cells.length, 8);

  // spread summary: the two big days spread apart, the flat middle day does not
  assert.ok(h.spreadSummary, 'spread summary present');
  assert.equal(h.spreadSummary.daysSpread, 2, 'two days spread past threshold with a leader ±0.25%');
  assert.equal(h.spreadSummary.daysComplete, 3);
  assert.ok(h.spreadSummary.medianOnsetMin != null);
});
