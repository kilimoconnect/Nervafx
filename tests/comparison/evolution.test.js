'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildIndices } = require('../../research/comparison/index-build');
const { liveEvolution, historyScan, windowCandleEvolution } = require('../../research/comparison/evolution');
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

test('spread windows: multiple episodes — apart, bunch back, apart again', () => {
  // EUR spreads out, bunches back, then spreads out again within one EAT day.
  const g = (t) => {
    const step = Math.round((t - DATA_START) / M15_MS);  // 0-based M15 index from data start
    const dstep = step - PRE;                             // step within the EAT day
    if (dstep >= 4 && dstep < 16) return 0.0010;          // widen: EUR climbs
    if (dstep >= 16 && dstep < 28) return -0.0010;        // bunch back toward the open
    if (dstep >= 28 && dstep < 40) return 0.0010;         // widen again
    return 0;
  };
  const by = network(PRE + STEPS_DAY + 1, g);
  const built = buildIndices(by);
  const asOf = START + (STEPS_DAY - 1) * M15_MS;
  const sp = liveEvolution(built, asOf, built.lastMs, 0.25, 0.30).spread;
  assert.ok(sp.episodes >= 2, 'at least two spread episodes detected, got ' + sp.episodes);
  assert.equal(sp.windows.length, sp.episodes);
  // windows are ordered and each has start ≤ end
  for (let i = 0; i < sp.windows.length; i++) {
    const w = sp.windows[i];
    assert.ok(w.endMs >= w.startMs, 'window end ≥ start');
    if (i > 0) assert.ok(w.startMs > sp.windows[i - 1].endMs, 'windows are disjoint and ordered');
  }
  assert.equal(sp.watchMs, sp.windows[0].startMs, 'watchMs is the first onset');
});

test('windowCandleEvolution: M15 10-EMA currency strength ranking inside each >threshold window', () => {
  const by = network(PRE + STEPS_DAY + 1, () => 0.0003);   // EUR up every M15 → EUR strongest
  const built = buildIndices(by);
  const asOf = START + (STEPS_DAY - 1) * M15_MS;
  const ev = liveEvolution(built, asOf, built.lastMs, 0.25, 0.30);
  const cw = ev.candleWindows;
  assert.ok(Array.isArray(cw) && cw.length >= 1, 'at least one window');
  const w = cw[0];
  assert.equal(w.resolution, 'M15');
  assert.equal(w.emaPeriod, 10);
  assert.ok(w.nSteps > 1);
  // strength OVER TIME: one line per currency, each an EMA array the length of the M15 timeline
  assert.equal(w.times.length, w.nSteps);
  assert.equal(w.times[1] - w.times[0], M15_MS, 'M15 spacing between steps');
  assert.equal(w.lines.length, 8);
  for (const ln of w.lines) {
    assert.equal(ln.ema.length, w.nSteps);
    assert.equal(ln.last, ln.ema[ln.ema.length - 1], 'last = series endpoint');
  }
  // the chart endpoint equals the snapshot strength (same metric)
  const eurLine = w.lines.find((l) => l.currency === 'EUR');
  const eurSnap = w.strength.find((r) => r.currency === 'EUR');
  assert.equal(eurLine.last, eurSnap.strength, 'line endpoint matches ranking value');
  // EUR rises steadily → its strength line trends up monotonically
  for (let i = 1; i < eurLine.ema.length; i++) assert.ok(eurLine.ema[i] >= eurLine.ema[i - 1] - 1e-9, 'EUR strength non-decreasing');
  // a full 8-currency strength ranking, sorted strongest→weakest, ranks 1..8
  assert.equal(w.strength.length, 8);
  for (let i = 1; i < w.strength.length; i++) assert.ok(w.strength[i - 1].strength >= w.strength[i].strength, 'sorted desc');
  assert.deepEqual(w.strength.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  // EUR strongest (rank 1, positive), its mirror weakest (rank 8, negative)
  assert.equal(w.strength[0].currency, 'EUR');
  assert.ok(w.strength[0].strength > 0 && w.strength[7].strength < 0);
  // strength is the SMOOTHED value, so its magnitude lags the raw % for a steady riser
  const eur = w.strength[0];
  assert.ok(eur.raw != null && eur.strength <= eur.raw + 1e-9, 'EMA strength ≤ raw for a riser');
  // every currency carries peak/trough and the three 0.25% move flags
  for (const r of w.strength) {
    assert.ok(r.peak >= r.trough - 1e-9);
    assert.equal(typeof r.pulledBack, 'boolean'); assert.equal(typeof r.bounced, 'boolean');
    assert.ok(r.pullback >= 0 && r.bounce >= 0);
  }
  // EUR only ever rises here → reachedUp, never a 0.25% pullback off a high
  assert.ok(eur.reachedUp && !eur.pulledBack, 'steady riser: up-from-open, no pullback');
});

test('windowCandleEvolution: a 0.25% pullback off a high is flagged (rise then retrace)', () => {
  // EUR climbs hard for the first ~2/3 of the day, then reverses down for the last third.
  const g = (t) => {
    const dstep = Math.round((t - DATA_START) / M15_MS) - PRE;   // M15 step within the EAT day
    if (dstep < 0) return 0;
    return dstep < Math.floor(STEPS_DAY * 0.66) ? 0.0008 : -0.0012;   // up, then a sharp reversal
  };
  const by = network(PRE + STEPS_DAY + 1, g);
  const built = buildIndices(by);
  const asOf = START + (STEPS_DAY - 1) * M15_MS;
  const ev = liveEvolution(built, asOf, built.lastMs, 0.25, 0.30);
  const w = ev.candleWindows[0];
  const eur = w.strength.find((r) => r.currency === 'EUR');
  assert.ok(eur.peak >= 0.25, 'EUR peaked above +0.25%');
  assert.ok(eur.pulledBack, 'EUR fell ≥0.25% back from its running high');
  assert.ok(eur.pullback >= 0.25 - 1e-9 && eur.pullbackMs != null && eur.pullbackMs > eur.peakMs);
  // USD mirrors EUR (quote side): it troughs then bounces ≥0.25% off its low
  const usd = w.strength.find((r) => r.currency === 'USD');
  assert.ok(usd.bounced && usd.bounce >= 0.25 - 1e-9, 'USD rose ≥0.25% off its low');
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
