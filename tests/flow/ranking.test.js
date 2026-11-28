'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { dirSeries, rankedSetups, participationSeries, isAligned, hasBos, alertable } = require('../../research/flow/ranking');

// A per-currency series: index-aligned ms / pp / confirmed-brick-direction arrays (what
// computeCompareData builds from each index's continuous Renko). ms are arbitrary ascending.
function series(dirArr, ppArr, ms0) {
  const base = ms0 || 1000;
  return { ms: dirArr.map((_, i) => base + i * 900000), dir: dirArr.slice(), pp: ppArr.slice() };
}
const rowFor = (rows, pair) => rows.find((r) => r.pair === pair);

test('an active setup forms when the two bricks oppose; gap = signed pp since it began', () => {
  // EUR green (up), USD red (down) throughout → EUR_USD setup active from i=0.
  const s = {
    EUR: series(['up', 'up', 'up', 'up'], [0, 0.1, 0.2, 0.3]),
    USD: series(['down', 'down', 'down', 'down'], [0, -0.1, -0.15, -0.2]),
  };
  const rows = rankedSetups(s, {}, {});
  const r = rowFor(rows, 'EUR_USD');
  assert.ok(r, 'EUR_USD has an active setup');
  assert.strictEqual(r.leanUp, true);
  assert.strictEqual(r.strong, 'EUR');       // green = buy
  assert.strictEqual(r.weak, 'USD');         // red = sell
  assert.strictEqual(r.setupStartMs, s.EUR.ms[0]);
  // gap = (EUR 0.3−0) − (USD −0.2−0) = 0.3 + 0.2 = 0.5
  assert.ok(Math.abs(r.gap - 0.5) < 1e-9, 'gap = +0.5 pp');
});

test('same-direction bricks produce no setup', () => {
  const s = {
    EUR: series(['up', 'up', 'up'], [0, 0.1, 0.2]),
    GBP: series(['up', 'up', 'up'], [0, 0.05, 0.1]),
  };
  assert.ok(!rowFor(rankedSetups(s, {}, {}), 'EUR_GBP'), 'EUR_GBP (both green) has no setup');
});

test('lean follows the brick when the base is red (sell the pair)', () => {
  // USD_CHF: USD red (base), CHF green (quote) → sell the pair; strong=CHF, weak=USD.
  const s = {
    USD: series(['down', 'down', 'down'], [0, -0.1, -0.2]),
    CHF: series(['up', 'up', 'up'], [0, 0.1, 0.25]),
  };
  const r = rowFor(rankedSetups(s, {}, {}), 'USD_CHF');
  assert.ok(r, 'USD_CHF active');
  assert.strictEqual(r.leanUp, false);
  assert.strictEqual(r.dir, 'down');
  assert.strictEqual(r.strong, 'CHF');
  assert.strictEqual(r.weak, 'USD');
  // gap = (CHF 0.25−0) − (USD −0.2−0) = 0.25 + 0.2 = 0.45
  assert.ok(Math.abs(r.gap - 0.45) < 1e-9, 'gap = +0.45 pp');
});

test('a setup survives midnight (the walk never resets on a day boundary)', () => {
  // ms straddle an EAT midnight; the setup begins before it and the gap spans it.
  const mid = Date.UTC(2026, 0, 2, 0, 0, 0);           // some UTC instant used as a "day boundary"
  const s = {
    EUR: series(['up', 'up', 'up', 'up'], [0, 0.1, 0.2, 0.4], mid - 2 * 900000),
    USD: series(['down', 'down', 'down', 'down'], [0, -0.1, -0.2, -0.3], mid - 2 * 900000),
  };
  const r = rowFor(rankedSetups(s, {}, {}), 'EUR_USD');
  assert.ok(r, 'setup still active across the boundary');
  assert.strictEqual(r.setupStartMs, s.EUR.ms[0], 'setup start held across midnight');
  assert.ok(Math.abs(r.gap - 0.7) < 1e-9, 'gap spans the boundary = 0.4 + 0.3');
});

test('an ended setup that later reforms restarts the reference', () => {
  // USD loses its brick at i=2 (setup ends), reopposes at i=3 → new setup start at i=3.
  const s = {
    EUR: series(['up', 'up', 'up', 'up', 'up'], [0, 0.1, 0.2, 0.3, 0.5]),
    USD: series(['down', 'down', null, 'down', 'down'], [0, -0.1, -0.2, -0.25, -0.35]),
  };
  const r = rowFor(rankedSetups(s, {}, {}), 'EUR_USD');
  assert.ok(r, 'setup reformed');
  assert.strictEqual(r.setupStartMs, s.EUR.ms[3], 'reference restarted at reformation (i=3)');
  // gap = (EUR 0.5−0.3) − (USD −0.35−(−0.25)) = 0.2 − (−0.1) = 0.3
  assert.ok(Math.abs(r.gap - 0.3) < 1e-9, 'gap measured from the reformation');
});

test('a direct lean reversal starts a new setup at the flip', () => {
  // i0,i1: EUR up / USD down (lean up). i2: EUR down / USD up (opposite but flipped) → new setup, sell.
  const s = {
    EUR: series(['up', 'up', 'down'], [0, 0.1, 0.05]),
    USD: series(['down', 'down', 'up'], [0, -0.1, 0.2]),
  };
  const r = rowFor(rankedSetups(s, {}, {}), 'EUR_USD');
  assert.ok(r, 'reversed setup active');
  assert.strictEqual(r.leanUp, false, 'lean flipped to down');
  assert.strictEqual(r.setupStartMs, s.EUR.ms[2], 'new setup at the flip');
  assert.strictEqual(r.strong, 'USD');   // USD now green
  assert.strictEqual(r.weak, 'EUR');     // EUR now red
  // gap = (USD 0.2−0.2) − (EUR 0.05−0.05) = 0  (started at the flip)
  assert.ok(Math.abs(r.gap - 0) < 1e-9, 'gap = 0 at the flip observation');
});

test('a negative-gap setup still qualifies (lean lost ground)', () => {
  // opposite bricks throughout, but pp moved AGAINST the lean → gap negative, row still present.
  const s = {
    EUR: series(['up', 'up', 'up'], [0, -0.05, -0.1]),
    USD: series(['down', 'down', 'down'], [0, 0.05, 0.1]),
  };
  const r = rowFor(rankedSetups(s, {}, {}), 'EUR_USD');
  assert.ok(r, 'negative-gap setup is still listed');
  // gap = (EUR −0.1−0) − (USD 0.1−0) = −0.2
  assert.ok(Math.abs(r.gap + 0.2) < 1e-9, 'gap = −0.2 pp');
});

test('rows sort by gap descending, then pair name', () => {
  const s = {
    EUR: series(['up', 'up'], [0, 0.4]),
    GBP: series(['up', 'up'], [0, 0.4]),   // ties EUR for the gap vs USD
    AUD: series(['up', 'up'], [0, 0.1]),
    USD: series(['down', 'down'], [0, -0.2]),
  };
  const rows = rankedSetups(s, {}, {});
  const gaps = rows.map((r) => r.gap);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i - 1] >= gaps[i], 'gap desc');
  // EUR_USD and GBP_USD tie (both 0.6); tie-break by pair name → EUR_USD before GBP_USD
  const iEUR = rows.findIndex((r) => r.pair === 'EUR_USD');
  const iGBP = rows.findIndex((r) => r.pair === 'GBP_USD');
  assert.ok(iEUR >= 0 && iGBP >= 0 && iEUR < iGBP, 'EUR_USD before GBP_USD on the tie');
});

test('replay uses only data through the cutoff (prefix is deterministic)', () => {
  const full = {
    EUR: series(['up', 'up', 'up', 'up', 'up'], [0, 0.1, 0.2, 0.3, 0.9]),
    USD: series(['down', 'down', 'down', 'down', 'down'], [0, -0.1, -0.2, -0.3, -0.9]),
  };
  const cut = 3; // through index 2
  const prefix = {
    EUR: { ms: full.EUR.ms.slice(0, cut), dir: full.EUR.dir.slice(0, cut), pp: full.EUR.pp.slice(0, cut) },
    USD: { ms: full.USD.ms.slice(0, cut), dir: full.USD.dir.slice(0, cut), pp: full.USD.pp.slice(0, cut) },
  };
  const a = rankedSetups(prefix, {}, {});
  const b = rankedSetups(prefix, {}, {});
  assert.deepStrictEqual(a, b, 'same input → identical output');
  const r = rowFor(a, 'EUR_USD');
  // gap at cutoff index 2 = (0.2−0) − (−0.2−0) = 0.4 (NOT the full-series 1.8)
  assert.ok(Math.abs(r.gap - 0.4) < 1e-9, 'gap computed only through the cutoff');
});

test('dirSeries carries the confirmed direction forward from each event', () => {
  const obs = [{ ms: 100 }, { ms: 200 }, { ms: 300 }, { ms: 400 }];
  // up brick confirmed at ms 200; down reversal confirmed at ms 400.
  const events = [
    { ms: 200, levels: [{ dir: 'up', kind: 'opening' }] },
    { ms: 400, levels: [{ dir: 'down', kind: 'reversal' }] },
  ];
  assert.deepStrictEqual(dirSeries(obs, events), [null, 'up', 'up', 'down']);
});

test('alertable keeps only aligned + in-direction-BoS rows, preserving order', () => {
  const s = {
    EUR: series(['up', 'up'], [0, 0.5]),
    USD: series(['down', 'down'], [0, -0.5]),   // EUR_USD lean up, big gap
    AUD: series(['up', 'up'], [0, 0.1]),        // AUD_USD lean up, small gap
  };
  const structures = { EUR_USD: 'up', AUD_USD: 'down' };  // EUR_USD aligned; AUD_USD diverging
  const bos = { EUR_USD: 'up', AUD_USD: 'up' };           // both have an up BoS
  const rows = rankedSetups(s, structures, bos);
  // sanity: isAligned/hasBos
  assert.ok(isAligned(rowFor(rows, 'EUR_USD')) && hasBos(rowFor(rows, 'EUR_USD')));
  assert.ok(!isAligned(rowFor(rows, 'AUD_USD')));
  const al = alertable(rows);
  const pairs = al.map((a) => a.pair);
  assert.ok(pairs.includes('EUR_USD'), 'EUR_USD alerts (aligned + up BoS)');
  assert.ok(!pairs.includes('AUD_USD'), 'AUD_USD excluded (structure diverges)');
  assert.strictEqual(al[0].pair, 'EUR_USD');
  assert.ok('gap' in al[0] && al[0].direction === 'up');
});

test('BoS against the lean direction does not alert', () => {
  const s = { EUR: series(['up', 'up'], [0, 0.5]), USD: series(['down', 'down'], [0, -0.5]) };
  const rows = rankedSetups(s, { EUR_USD: 'up' }, { EUR_USD: 'down' });  // down BoS, up lean
  assert.strictEqual(alertable(rows).length, 0);
});

test('combined {up,down} BoS object qualifies when the lean direction is present', () => {
  const s = { EUR: series(['up', 'up'], [0, 0.5]), USD: series(['down', 'down'], [0, -0.5]) };
  // H1-only up BoS (15M absent) → object has up:true → alerts for the up lean.
  const upOnly = rankedSetups(s, { EUR_USD: 'up' }, { EUR_USD: { up: true, down: false } });
  assert.strictEqual(alertable(upOnly).length, 1);
  assert.strictEqual(alertable(upOnly)[0].pair, 'EUR_USD');
  // object with only down present, up lean → no alert.
  const downOnly = rankedSetups(s, { EUR_USD: 'up' }, { EUR_USD: { up: false, down: true } });
  assert.strictEqual(alertable(downOnly).length, 0);
});

test('participationSeries sums the gaps of only the pairs above +0.200 pp at each snapshot', () => {
  const s = {
    EUR: series(['up', 'up', 'up'], [0, 0.1, 0.3]),
    USD: series(['down', 'down', 'down'], [0, -0.1, -0.3]),   // EUR_USD & GBP_USD oppose USD
    GBP: series(['up', 'up', 'up'], [0, 0.05, 0.1]),
  };
  const ser = participationSeries(s, 0.2);
  assert.strictEqual(ser.length, 3, 'one point per timeline snapshot');
  // i=0: all gaps 0 → nothing qualifies.
  assert.strictEqual(ser[0].sum, 0);
  assert.strictEqual(ser[0].count, 0);
  // i=1: EUR_USD gap exactly 0.2 (not > 0.2), GBP_USD 0.15 → still nothing.
  assert.strictEqual(ser[1].count, 0, '0.200 pp is below the strict threshold');
  // i=2: EUR_USD 0.6 + GBP_USD 0.4 both qualify → sum 1.0 over 2 pairs.
  assert.strictEqual(ser[2].count, 2);
  assert.ok(Math.abs(ser[2].sum - 1.0) < 1e-9, 'sum = 0.6 + 0.4');
});

test('participationSeries returns [] when there is no usable timeline', () => {
  assert.deepStrictEqual(participationSeries({}, 0.2), []);
});

test('a pair is not alertable until its gap clears +0.200 pp', () => {
  // gap = 0.18 (< 0.2): aligned + BoS but below threshold → no alert.
  const below = { EUR: series(['up', 'up'], [0, 0.15]), USD: series(['down', 'down'], [0, -0.03]) };
  const rBelow = rankedSetups(below, { EUR_USD: 'up' }, { EUR_USD: { up: true, down: false } });
  assert.ok(Math.abs(rowFor(rBelow, 'EUR_USD').gap - 0.18) < 1e-9);
  assert.strictEqual(alertable(rBelow).length, 0, 'gap 0.18 pp does not alert');
  // gap = 0.25 (> 0.2) → alerts.
  const above = { EUR: series(['up', 'up'], [0, 0.2]), USD: series(['down', 'down'], [0, -0.05]) };
  const rAbove = rankedSetups(above, { EUR_USD: 'up' }, { EUR_USD: { up: true, down: false } });
  assert.strictEqual(alertable(rAbove).length, 1, 'gap 0.25 pp alerts');
});
