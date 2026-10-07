'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { defineCandidate } = require('../../research/m15/registry');
const { REGISTRY, A0, A2, C } = require('../../research/m15/candidates');
const { runCandidate } = require('../../research/m15/experiment');

const M15 = 15 * 60 * 1000, T0 = Date.UTC(2026, 8, 20, 0, 0, 0);
function frame(i, pairs, ok = true) { const closeMs = T0 + i * M15; const P = {}; for (const p of Object.keys(pairs)) P[p] = { ...pairs[p], pair: p, closeMs }; return { closeMs, ok, pairs: P }; }
function feat(R10, P10 = 100, z10 = 1, R4 = 0, P4 = 0) { return { horizons: { 10: { R: R10, P: P10, z: z10 }, 4: { R: R4, P: P4 } } }; }
const eurusd = (o) => ({ EUR_USD: o });

test('registry: 11 candidates, 15 enumerated parameter variants (constrained budget)', () => {
  assert.equal(REGISTRY.candidates.length, 11);
  assert.equal(REGISTRY.variantBudget.totalParameterVariants, 15);
  assert.ok(REGISTRY.byId['CTRL_pseudo_random'] && REGISTRY.byId['NULL_no_signal']); // control + no-signal present
});

test('immutability: a candidate is frozen; changing a rule yields a NEW ruleHash', () => {
  assert.ok(Object.isFrozen(A0));
  const h1 = A0.ruleHash;
  const changed = defineCandidate({ ...A0, params: { deadbandZ: 0.9 }, variants: [{ deadbandZ: 0.9 }], decide: A0.decide });
  assert.notEqual(changed.ruleHash, h1);   // rule edit ⇒ new hash (cannot edit history in place)
});

test('transitions: baseline arms+triggers, dedups repeats, reverses on flip', () => {
  const r = runCandidate(A0, [frame(0, eurusd({ feat: feat(0.004) })), frame(1, eurusd({ feat: feat(0.004) })), frame(2, eurusd({ feat: feat(-0.004) }))], { params: { deadbandZ: 0 } });
  assert.equal(r.counts.started, 1);
  assert.equal(r.counts.triggered, 1);
  assert.equal(r.counts.dedupSkipped, 1);      // close 1 repeats the same LONG evidence
  assert.equal(r.counts.invalidated, 1);       // close 2 flips ⇒ reversed
});

test('repeated-close / identical evidence ⇒ ONE episode (dedup)', () => {
  const closes = [0, 1, 2, 3].map((i) => frame(i, eurusd({ feat: feat(0.004) })));
  const r = runCandidate(A0, closes, { params: { deadbandZ: 0 } });
  assert.equal(r.episodes.length, 1);
  assert.equal(r.counts.dedupSkipped, 3);
});

test('conflicting currencies ⇒ no episode (A2 breadth gate fails)', () => {
  // R10 up ⇒ LONG, but breadth spread (EUR.net − USD.net) = 0 < breadthMin ⇒ arm false
  const net = { breadth: { EUR: { net: 0 }, USD: { net: 0 } }, gap: { EUR_USD: 0 } };
  const r = runCandidate(A2, [frame(0, eurusd({ feat: feat(0.004, 90), net }))], { params: { consistMin: 50, breadthMin: 1 } });
  assert.equal(r.counts.started, 0);
});

test('missing snapshot ⇒ no action', () => {
  const r = runCandidate(A0, [frame(0, eurusd({ feat: feat(0.004) }), false)], { params: { deadbandZ: 0 } });
  assert.equal(r.counts.missingSkipped, 1);
  assert.equal(r.counts.started, 0);
});

test('incomplete candle (no features) ⇒ no new action', () => {
  const r = runCandidate(A0, [frame(0, eurusd({ feat: null }))], { params: { deadbandZ: 0 } });
  assert.equal(r.counts.incompleteSkipped, 1);
  assert.equal(r.counts.started, 0);
});

test('production family C reuses frozen prod semantics; missing prod ⇒ incomplete', () => {
  const prod = { marketState: { state: 'BULLISH_EXPANSION' }, expansion: { state: 'EARLY' }, freshness: { state: 'FRESH' } };
  const armed = runCandidate(C, [frame(0, eurusd({ prod }))]);
  assert.equal(armed.counts.started, 1);
  const missing = runCandidate(C, [frame(0, eurusd({ prod: null }))]);
  assert.equal(missing.counts.incompleteSkipped, 1);
  assert.equal(missing.counts.started, 0);
});

test('replay from frozen inputs is deterministic; episode id/timestamp fixed at detection', () => {
  const closes = [0, 1, 2].map((i) => frame(i, eurusd({ feat: feat(0.004) })));
  const a = runCandidate(A0, closes, { params: { deadbandZ: 0 } });
  const b = runCandidate(A0, closes, { params: { deadbandZ: 0 } });
  assert.deepEqual(a.episodes, b.episodes);
  assert.equal(a.episodes[0].firstCloseMs, T0);        // fixed at detection — cannot move after outcomes
  assert.match(a.episodes[0].id, /^[0-9a-f]{20}$/);
});
