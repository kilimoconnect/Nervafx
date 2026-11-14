'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { currencyStrength, allComplete, scoreSum } = require('../../research/breakout/strength');
const { validThreshold } = require('../../research/breakout/config');
const { rankDir, RANK_VALUES, CURRENCIES, PAIRS } = require('./fixtures');

test('base/quote inversion: a bullish pair votes +1 base, −1 quote', () => {
  // only EUR_USD known, bullish → EUR gets +1 from this leg, USD gets −1
  const st = currencyStrength({ EUR_USD: 1 }, 5);
  const eurLeg = st.EUR.contributions.find((x) => x.pair === 'EUR_USD');
  const usdLeg = st.USD.contributions.find((x) => x.pair === 'EUR_USD');
  assert.equal(eurLeg.contribution, 1, 'EUR is the base → +1 on a bullish pair');
  assert.equal(usdLeg.contribution, -1, 'USD is the quote → −1 on a bullish pair');
  // both are incomplete (only one of seven legs known) → not classified strong/weak
  assert.equal(st.EUR.complete, false);
  assert.equal(st.EUR.classification, 'insufficient');
});

test('complete data → eight scores sum to zero (zero-sum construction)', () => {
  const st = currencyStrength(rankDir(RANK_VALUES), 5);
  assert.ok(allComplete(st), 'all 28 directions known → every currency complete');
  assert.equal(scoreSum(st), 0, 'scores sum to zero');
  // the strict ranking makes NZD strongest (+7) and USD weakest (−7)
  assert.equal(st.NZD.score, 7);
  assert.equal(st.USD.score, -7);
  assert.equal(st.NZD.classification, 'strong');
  assert.equal(st.USD.classification, 'weak');
});

test('classification bands at the default threshold of 5', () => {
  // make GBP exactly bull=5/bear=2 (score +3) → strong at threshold 5
  // ranking values put GBP above 5 of its counterparts and below 2
  const vals = { USD: 0, EUR: 1, JPY: 2, CHF: 3, CAD: 4, GBP: 5, AUD: 6, NZD: 7 };
  const st = currencyStrength(rankDir(vals), 5);
  assert.equal(st.GBP.bull, 5);
  assert.equal(st.GBP.bear, 2);
  assert.equal(st.GBP.score, 3);
  assert.equal(st.GBP.classification, 'strong');
});

test('neutral band exists only when threshold > 4', () => {
  // CHF with bull=4/bear=3 (score +1)
  const vals = { USD: 0, EUR: 1, GBP: 2, JPY: 3, CHF: 4, CAD: 5, AUD: 6, NZD: 7 };
  // pick a currency with 4/3 split: value 4 beats {0,1,2,3}=4 and loses to {5,6,7}=3 → CHF bull=4 bear=3
  const chf4 = currencyStrength(rankDir(vals), 4).CHF;
  const chf5 = currencyStrength(rankDir(vals), 5).CHF;
  assert.equal(chf4.bull, 4); assert.equal(chf4.bear, 3);
  assert.equal(chf4.classification, 'strong', 'bull 4 ≥ threshold 4 → strong');
  assert.equal(chf5.classification, 'neutral', 'bull 4 < threshold 5 → neutral');
});

test('unknown states make a currency insufficient and are NOT counted as neutral votes', () => {
  // omit one of EUR's legs → EUR incomplete; its counterpart also incomplete
  const pd = rankDir(RANK_VALUES, ['EUR_USD']);
  const st = currencyStrength(pd, 5);
  assert.equal(st.EUR.complete, false);
  assert.equal(st.EUR.classification, 'insufficient');
  assert.equal(st.USD.complete, false, 'USD shares the omitted leg → also incomplete');
  // the omitted leg carries contribution null (not a 0/neutral vote)
  const omitted = st.EUR.contributions.find((x) => x.pair === 'EUR_USD');
  assert.equal(omitted.contribution, null);
  // currencies not touching EUR_USD remain complete
  assert.equal(st.AUD.complete, true);
});

test('threshold validation clamps to an integer in [4,7]', () => {
  assert.equal(validThreshold(2), 4);
  assert.equal(validThreshold(9), 7);
  assert.equal(validThreshold(5.4), 5);
  assert.equal(validThreshold('x'), 5);   // default
});

test('every currency receives exactly seven contributions', () => {
  const st = currencyStrength(rankDir(RANK_VALUES), 5);
  for (const c of CURRENCIES) assert.equal(st[c].contributions.length, 7, c + ' has 7 legs');
  assert.equal(PAIRS.length, 28);
});
