'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { persistence, onset, extension, enrich } = require('../../research/movement/analytics');
const { buildSeries } = require('../../research/movement/engine');
const { CONFIG, PAIRS, M15_MS, pairsForCurrency } = require('../../research/movement/config');

const START = Date.UTC(2025, 0, 6, 0, 0, 0);
const obs = (arr) => arr.map((o, i) => ({ ms: START + i * M15_MS, score: o[0], direction: o[1], support: o[2] == null ? (o[1] === 'STRENGTHENING' ? 5 : o[1] === 'WEAKENING' ? 5 : 0) : o[2] }));

test('persistence: consecutive same-direction count and totals', () => {
  const s = obs([[0.1, 'MIXED'], [0.2, 'MIXED'], [1, 'STRENGTHENING'], [1.1, 'STRENGTHENING'], [1.2, 'STRENGTHENING'], [1.3, 'STRENGTHENING']]);
  const p = persistence(s, CONFIG);
  assert.equal(p.consecutive, 4);
  assert.equal(p.direction, 'STRENGTHENING');
  assert.equal(p.supporting, 4);
});

test('causal onset: first vs confirmed timestamps; confirmation never backdated', () => {
  const s = obs([[0.1, 'MIXED'], [0.2, 'MIXED'], [1.0, 'STRENGTHENING'], [1.0, 'STRENGTHENING'], [1.0, 'STRENGTHENING'], [1.0, 'STRENGTHENING']]);
  const anchor = s[s.length - 1].ms;
  const o = onset(s, CONFIG, anchor);
  assert.equal(o.detected, true);
  assert.equal(o.direction, 'STRENGTHENING');
  assert.equal(o.firstUtc, new Date(s[2].ms).toISOString());      // first of the run
  assert.equal(o.confirmedUtc, new Date(s[4].ms).toISOString());  // 3rd of the run (persistMin=3)
  assert.ok(new Date(o.confirmedUtc) >= new Date(o.firstUtc), 'confirmation not before onset');
  assert.equal(o.ageBars, 1);
});

test('onset not detected when the rule is unmet (short run)', () => {
  const s = obs([[0.1, 'MIXED'], [1.0, 'STRENGTHENING'], [1.0, 'STRENGTHENING']]);   // only 2 in a row (<persistMin)
  assert.equal(onset(s, CONFIG, s[s.length - 1].ms).detected, false);
});

test('extension: label from the |score| percentile', () => {
  const vals = []; for (let i = 0; i < 40; i++) vals.push([0.1 + i * 0.01, 'MIXED']);
  vals.push([5.0, 'STRENGTHENING']);   // far above the historical distribution
  const e = extension(obs(vals), CONFIG);
  assert.equal(e.available, true);
  assert.ok(e.magnitudePercentile >= 0.95);
  assert.equal(e.label, 'unusually extended');
});

// No-future-leakage: enriching as-of t is unchanged by appending later candles.
function gen(n, fn) { const o = []; for (let i = 0; i < n; i++) { const c = fn(i); o.push({ openMs: START + i * M15_MS, open: c, high: c, low: c, close: c }); } return o; }
const nz = (seed) => (i) => 1.0 + 0.0012 * Math.sin((i + seed * 11) / 6) + 0.0007 * Math.cos((i + seed * 7) / 3);

test('no future leakage: enrich as-of t is identical after appending future candles', () => {
  const n = 400; const by = {}; PAIRS.forEach((p, k) => { by[p] = gen(n, nz(k + 1)); });
  // drive AUD strengthening over the last ~40 candles
  const drift = (i, up) => (i >= n - 40 ? (up ? 0.03 : -0.03) * (i - (n - 40)) / 40 : 0);
  for (const leg of pairsForCurrency('AUD')) { const up = leg.role === 'base'; by[leg.pair] = gen(n, (i) => nz(PAIRS.indexOf(leg.pair) + 1)(i) + drift(i, up)); }
  const asOf = START + (n - 1) * M15_MS + M15_MS;
  const a = enrich(buildSeries(by), '4h', CONFIG, asOf, 48);
  // append future candles and re-enrich at the SAME asOf
  const by2 = {}; PAIRS.forEach((p, k) => { const ext = gen(40, (i) => nz(k + 1)(n + i)); by2[p] = by[p].concat(ext.map((c, i) => ({ openMs: START + (n + i) * M15_MS, open: c.open, high: c.high, low: c.low, close: c.close }))); });
  const b = enrich(buildSeries(by2), '4h', CONFIG, asOf, 48);
  assert.equal(JSON.stringify(a.currencies.AUD.score), JSON.stringify(b.currencies.AUD.score));
  assert.equal(JSON.stringify(a.currencies.AUD.onset), JSON.stringify(b.currencies.AUD.onset));
  assert.ok(a.currencies.AUD.score > 0, 'AUD strengthening detected');
});
