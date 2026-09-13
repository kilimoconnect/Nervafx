'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateCurrencyStrength, pairSignal, pairStrengthDifferential } = require('../../api/_m15/strength');
const { PAIRS } = require('../../api/_m15/pairs');

const zero = () => Object.fromEntries(PAIRS.map((p) => [p, { strength: 0, acceleration: 0 }]));

test('inversion (§32): EUR_USD up strengthens EUR, weakens USD', () => {
  const s = zero();
  s['EUR_USD'] = { strength: 1, acceleration: 0 };
  const { byCurrency } = evaluateCurrencyStrength(s);
  assert.ok(byCurrency['EUR'].strengthScore > 0, 'EUR strengthens');
  assert.ok(byCurrency['USD'].strengthScore < 0, 'USD weakens');
  assert.equal(byCurrency['EUR'].strengthDirection, 'BULLISH');
  assert.equal(byCurrency['USD'].strengthDirection, 'BEARISH');
});

test('mirror symmetry: flipping every signal flips every currency score', () => {
  const s = zero();
  s['GBP_JPY'] = { strength: 0.8, acceleration: 0.2 };
  s['AUD_USD'] = { strength: -0.5, acceleration: 0 };
  const up = evaluateCurrencyStrength(s).byCurrency;
  const flip = zero();
  flip['GBP_JPY'] = { strength: -0.8, acceleration: -0.2 };
  flip['AUD_USD'] = { strength: 0.5, acceleration: 0 };
  const dn = evaluateCurrencyStrength(flip).byCurrency;
  for (const c of Object.keys(up)) {
    assert.ok(Math.abs(up[c].strengthScore + dn[c].strengthScore) < 1e-6, `${c} not symmetric`);
  }
});

test('broad participation beats a single-pair move for breadth', () => {
  // USD strong against everything (broad)
  const broad = zero();
  for (const p of PAIRS) {
    if (p.startsWith('USD_')) broad[p] = { strength: 0.6, acceleration: 0 };      // USD base up
    else if (p.endsWith('_USD')) broad[p] = { strength: -0.6, acceleration: 0 };  // USD quote, pair down ⇒ USD up
  }
  const bBroad = evaluateCurrencyStrength(broad).byCurrency['USD'];
  // USD strong via one pair only
  const narrow = zero();
  narrow['EUR_USD'] = { strength: -0.6, acceleration: 0 };
  const bNarrow = evaluateCurrencyStrength(narrow).byCurrency['USD'];
  assert.ok(bBroad.breadth > bNarrow.breadth);
  assert.ok(bBroad.strengthScore > bNarrow.strengthScore);
});

test('level and acceleration are separate fields (§13)', () => {
  const s = zero();
  s['EUR_USD'] = { strength: 0.9, acceleration: -0.9 }; // extreme but decelerating
  const eur = evaluateCurrencyStrength(s).byCurrency['EUR'];
  assert.ok(eur.strengthScore > 0);
  assert.ok(eur.strengthAcceleration < 0, 'deteriorating acceleration is reported separately');
});

test('ranks are 1..8 and ordered by score', () => {
  const s = zero();
  s['EUR_USD'] = { strength: 1, acceleration: 0 };
  s['GBP_USD'] = { strength: 0.5, acceleration: 0 };
  const { byCurrency, ranked } = evaluateCurrencyStrength(s);
  assert.equal(ranked.length, 8);
  assert.equal(byCurrency[ranked[0]].strengthRank, 1);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(byCurrency[ranked[i - 1]].strengthScore >= byCurrency[ranked[i]].strengthScore);
  }
});

test('pairStrengthDifferential = base − quote', () => {
  const s = zero();
  s['EUR_USD'] = { strength: 1, acceleration: 0 };
  const { byCurrency } = evaluateCurrencyStrength(s);
  const diff = pairStrengthDifferential('EUR_USD', byCurrency);
  assert.ok(Math.abs(diff - (byCurrency['EUR'].strengthScore - byCurrency['USD'].strengthScore)) < 1e-9);
  assert.ok(diff > 0);
});

test('pairSignal squashes velocity into (−1,1) and is 0 for no movement', () => {
  assert.deepEqual(pairSignal(null), { strength: 0, acceleration: 0 });
  const s = pairSignal({ velocity: 5, acceleration: -5 });
  assert.ok(s.strength > 0 && s.strength < 1);
  assert.ok(s.acceleration < 0 && s.acceleration > -1);
});

test('deterministic', () => {
  const s = zero(); s['CHF_JPY'] = { strength: 0.3, acceleration: 0.1 };
  assert.deepEqual(evaluateCurrencyStrength(s), evaluateCurrencyStrength(s));
});
