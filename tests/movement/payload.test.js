'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { actionState, freshness } = require('../../research/movement/payload');
const { CONFIG, PAIRS, M15_MS } = require('../../research/movement/config');
const { buildSeries } = require('../../research/movement/engine');

test('action states are evidence-based (never Buy/Sell)', () => {
  assert.equal(actionState({ coverage: { valid: 2 }, direction: 'MIXED' }).key, 'INSUFFICIENT');
  assert.equal(actionState({ coverage: { valid: 7 }, direction: 'MIXED' }).key, 'CONFLICTING');
  assert.equal(actionState({ coverage: { valid: 7 }, direction: 'STRENGTHENING', extension: { available: true, label: 'unusually extended' } }).key, 'EXTENDED');
  assert.equal(actionState({ coverage: { valid: 7 }, direction: 'STRENGTHENING', onset: { detected: true } }).key, 'INVESTIGATE');
  assert.equal(actionState({ coverage: { valid: 7 }, direction: 'WEAKENING', onset: { detected: false } }).key, 'AWAIT_SETUP');
  for (const a of ['INSUFFICIENT', 'CONFLICTING', 'EXTENDED', 'INVESTIGATE', 'AWAIT_SETUP']) { /* labels never contain buy/sell */ }
  assert.ok(!/buy|sell/i.test(JSON.stringify([actionState({ coverage: { valid: 7 }, direction: 'STRENGTHENING', onset: { detected: true } })])));
});

test('freshness flags stale pairs and never counts them as present', () => {
  const START = Date.UTC(2025, 0, 6, 0, 0, 0);
  const by = {}; PAIRS.forEach((p) => { by[p] = []; for (let i = 0; i < 20; i++) by[p].push({ openMs: START + i * M15_MS, open: 1, high: 1, low: 1, close: 1 }); });
  // make one pair stale (ends 10 bars earlier)
  by['EUR_USD'] = by['EUR_USD'].slice(0, 10);
  const f = freshness(buildSeries(by), START + 20 * M15_MS);
  assert.ok(f.pairsStale.includes('EUR_USD'));
  assert.equal(f.pairsFresh, PAIRS.length - 1);
});
