'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rankPairs } = require('../../api/_m15/ranking');
const { runNetwork } = require('../../api/_m15/coordinator');
const { PAIRS } = require('../../api/_m15/pairs');
const { mk, flat } = require('./_helpers');

// ── Ranking ──────────────────────────────────────────────────────────────────
test('ranking favours fresh armed setups over late/dead pairs', () => {
  const input = PAIRS.map((p) => ({ pair: p, agreement: { state: 'NO_AGREEMENT' }, freshness: { state: 'PREPARING' }, expansion: {}, energy: { energyLevel: 'LOW' }, strengthDiff: 0, basePower: {}, quotePower: {}, decision: 'NO_TRADE_DEAD' }));
  input[0] = { pair: 'EUR_USD', agreement: { state: 'STRONG_BULLISH' }, freshness: { state: 'FRESH' }, expansion: { focus: true, spaceSufficient: true }, energy: { energyLevel: 'ACTIVE', energyAcceleration: 'RISING' }, strengthDiff: 60, basePower: { powerScore: 80 }, quotePower: { powerScore: 20 }, decision: 'ARMED_BULLISH' };
  const ranked = rankPairs(input);
  assert.equal(ranked[0].pair, 'EUR_USD');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].qualifies, true);
});

test('ranking de-weights correlated duplicate exposure (§26)', () => {
  // Two strong USD-bullish pairs; the second (sharing USD) should be damped.
  const base = PAIRS.map((p) => ({ pair: p, agreement: { state: 'NO_AGREEMENT' }, freshness: { state: 'PREPARING' }, expansion: {}, energy: { energyLevel: 'LOW' }, strengthDiff: 0, basePower: {}, quotePower: {}, decision: 'NO_TRADE_DEAD' }));
  const strong = { agreement: { state: 'STRONG_BULLISH' }, freshness: { state: 'FRESH' }, expansion: { focus: true, spaceSufficient: true }, energy: { energyLevel: 'ACTIVE', energyAcceleration: 'RISING' }, strengthDiff: 60, basePower: { powerScore: 80 }, quotePower: { powerScore: 20 } };
  const iUsdChf = PAIRS.indexOf('USD_CHF'), iUsdCad = PAIRS.indexOf('USD_CAD');
  base[iUsdChf] = { pair: 'USD_CHF', ...strong, decision: 'ARMED_BULLISH' };
  base[iUsdCad] = { pair: 'USD_CAD', ...strong, decision: 'ARMED_BULLISH' };
  const ranked = rankPairs(base);
  const chf = ranked.find((r) => r.pair === 'USD_CHF'), cad = ranked.find((r) => r.pair === 'USD_CAD');
  const second = chf.rank < cad.rank ? cad : chf;
  assert.ok(second.correlationPenalty > 0, 'the correlated duplicate is penalized');
});

// ── Coordinator ──────────────────────────────────────────────────────────────
function trend(n, base, step) { const out = []; let p = base; for (let i = 0; i < n; i++) { const o = p; p += step; out.push(mk(i, o, Math.max(o, p) + 0.00004, Math.min(o, p) - 0.00004, p)); } return out; }
function network() {
  const byPair = {};
  for (const p of PAIRS) byPair[p] = flat(120, 1.1);
  byPair['EUR_USD'] = trend(120, 1.1000, 0.0005);   // one trending pair
  return byPair;
}

test('coordinator processes all 28 pairs at one synchronized frame', () => {
  const evalMs = Date.UTC(2026, 8, 11, 20, 30);
  const r = runNetwork(network(), { evalMs });
  assert.equal(Object.keys(r.pairs).length, 28);
  assert.equal(r.ranking.length, 28);
  assert.equal(r.run.pairsProcessed, 28);
  assert.equal(Object.keys(r.currencies.strength.byCurrency).length, 8);
  for (const p of PAIRS) assert.ok(r.pairs[p].marketState && r.pairs[p].decision);
});

test('coordinator is reproducible: identical inputs ⇒ identical run + idempotency key (§27)', () => {
  const evalMs = Date.UTC(2026, 8, 11, 20, 30);
  const a = runNetwork(network(), { evalMs });
  const b = runNetwork(network(), { evalMs });
  assert.equal(a.run.idempotencyKey, b.run.idempotencyKey);
  assert.equal(a.run.inputDataHash, b.run.inputDataHash);
  assert.deepEqual(a.pairs['EUR_USD'].decision, b.pairs['EUR_USD'].decision);
});

test('different frame ⇒ different idempotency key', () => {
  const base = network();
  const a = runNetwork(base, { evalMs: Date.UTC(2026, 8, 11, 20, 30) });
  const b = runNetwork(base, { evalMs: Date.UTC(2026, 8, 11, 20, 45) });
  assert.notEqual(a.run.idempotencyKey, b.run.idempotencyKey);
});

test('no order side-effects: run carries setups/triggers as data only, never orders', () => {
  const r = runNetwork(network(), { evalMs: Date.UTC(2026, 8, 11, 20, 30) });
  const json = JSON.stringify(r);
  for (const forbidden of ['orderId', 'placeOrder', 'ea_command', 'lots', 'executeTrade']) {
    assert.ok(!json.includes(forbidden), `run must not contain '${forbidden}'`);
  }
});
