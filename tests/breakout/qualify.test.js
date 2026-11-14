'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { qualifyPairs } = require('../../research/breakout/qualify');

// Minimal strength map builder: pass a map currency->classification (+ optional score).
function strengthOf(classes) {
  const out = {};
  for (const c of Object.keys(classes)) out[c] = { classification: classes[c], score: 0, complete: classes[c] !== 'insufficient' };
  return out;
}

function find(all, pair) { return all.find((p) => p.pair === pair); }

test('Strong base + Weak quote → BUY candidate', () => {
  const st = strengthOf({ EUR: 'strong', USD: 'weak', GBP: 'neutral', JPY: 'neutral', CHF: 'neutral', CAD: 'neutral', AUD: 'neutral', NZD: 'neutral' });
  const q = qualifyPairs(st);
  assert.equal(find(q.all, 'EUR_USD').direction, 'BUY');
  assert.ok(q.qualified.some((p) => p.pair === 'EUR_USD' && p.direction === 'BUY'));
});

test('Weak base + Strong quote → SELL candidate', () => {
  const st = strengthOf({ EUR: 'weak', USD: 'strong', GBP: 'neutral', JPY: 'neutral', CHF: 'neutral', CAD: 'neutral', AUD: 'neutral', NZD: 'neutral' });
  assert.equal(find(qualifyPairs(st).all, 'EUR_USD').direction, 'SELL');
});

test('Strong + Strong and Weak + Weak are excluded with a reason', () => {
  const ss = strengthOf({ EUR: 'strong', USD: 'strong', GBP: 'weak', JPY: 'weak', CHF: 'neutral', CAD: 'neutral', AUD: 'neutral', NZD: 'neutral' });
  const q = qualifyPairs(ss);
  assert.equal(find(q.all, 'EUR_USD').direction, null);
  assert.equal(find(q.all, 'EUR_USD').reason, 'both-strong');
  assert.equal(find(q.all, 'GBP_JPY').reason, 'both-weak');
});

test('a neutral leg excludes the pair', () => {
  const st = strengthOf({ EUR: 'strong', USD: 'neutral', GBP: 'neutral', JPY: 'neutral', CHF: 'neutral', CAD: 'neutral', AUD: 'neutral', NZD: 'neutral' });
  const r = find(qualifyPairs(st).all, 'EUR_USD');
  assert.equal(r.direction, null);
  assert.equal(r.reason, 'neutral-leg');
});

test('an insufficient leg excludes the pair (insufficient reason wins over class)', () => {
  const st = strengthOf({ EUR: 'strong', USD: 'insufficient', GBP: 'neutral', JPY: 'neutral', CHF: 'neutral', CAD: 'neutral', AUD: 'neutral', NZD: 'neutral' });
  const r = find(qualifyPairs(st).all, 'EUR_USD');
  assert.equal(r.direction, null);
  assert.equal(r.reason, 'quote-insufficient');
});

test('all 28 pairs are evaluated and qualified is a strict subset', () => {
  const st = strengthOf({ EUR: 'strong', USD: 'weak', GBP: 'strong', JPY: 'weak', CHF: 'neutral', CAD: 'neutral', AUD: 'neutral', NZD: 'neutral' });
  const q = qualifyPairs(st);
  assert.equal(q.all.length, 28);
  // EUR_USD, GBP_USD, EUR_JPY, GBP_JPY qualify (strong/weak combos); every qualified has a direction
  assert.ok(q.qualified.every((p) => p.direction === 'BUY' || p.direction === 'SELL'));
  assert.ok(q.qualified.length >= 1 && q.qualified.length < 28);
});
