'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runNetwork } = require('../../api/_m15/coordinator');
const { gateWaterfall, reduceEpisodes } = require('../../api/_m15/diagnostics');
const { PAIRS } = require('../../api/_m15/pairs');

const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 1, 0, 0, 0);

// Deterministic per-pair candle generator (varied trend/vol so many states arise).
function genPair(seed, n = 120) {
  const out = [];
  let price = 1.10 + (seed % 7) * 0.01;
  const drift = ((seed % 5) - 2) * 0.00003;          // -0.00006..+0.00006
  const amp = 0.0004 + (seed % 4) * 0.0003;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / (3 + (seed % 5))) * amp;
    const open = price;
    price = price + drift + (wave - (out.length ? 0 : 0)) * 0.15 + ((i * 7 + seed) % 11 - 5) * 0.00001;
    const hi = Math.max(open, price) + amp * 0.2;
    const lo = Math.min(open, price) - amp * 0.2;
    const openMs = T0 + i * M15;
    out.push({ openMs, time: new Date(openMs).toISOString(), open, high: hi, low: lo, close: price, volume: 100 + (i % 20), complete: true });
  }
  return out;
}

function buildAll() {
  const cbp = {};
  PAIRS.forEach((p, idx) => { cbp[p] = genPair(idx + 1); });
  const evalMs = cbp['EUR_USD'].slice(-1)[0].openMs;
  return { cbp, evalMs };
}

test('diagnostics:true does not change any decision (byte-identical decisions)', () => {
  const { cbp, evalMs } = buildAll();
  const off = runNetwork(cbp, { evalMs, diagnostics: false });
  const on = runNetwork(cbp, { evalMs, diagnostics: true });
  for (const p of PAIRS) {
    assert.equal(on.pairs[p].decision, off.pairs[p].decision, `${p} decision changed under instrumentation`);
    assert.equal(on.pairs[p].marketState.state, off.pairs[p].marketState.state);
    assert.equal(on.pairs[p].agreement.state, off.pairs[p].agreement.state);
  }
  // idempotency key identical ⇒ nothing about the run changed
  assert.equal(on.run.idempotencyKey, off.run.idempotencyKey);
});

test('gate waterfall re-derives the exact displayed decision for every pair', () => {
  const { cbp, evalMs } = buildAll();
  const run = runNetwork(cbp, { evalMs, diagnostics: true });
  for (const p of PAIRS) {
    const w = gateWaterfall(run.pairs[p]);
    assert.equal(w.primaryPredicted, run.pairs[p].decision, `${p}: predicted ${w.primaryPredicted} != actual ${run.pairs[p].decision}`);
    for (const g of w.gates) assert.ok(g.status === 'PASS' || g.status === 'FAIL', `${p} gate ${g.name} bad status`);
  }
});

test('INSUFFICIENT_SPACE is flagged not-applicable when no setup exists', () => {
  const { cbp, evalMs } = buildAll();
  const run = runNetwork(cbp, { evalMs, diagnostics: true });
  for (const p of PAIRS) {
    const w = gateWaterfall(run.pairs[p]);
    const space = w.gates.find((g) => g.name === 'INSUFFICIENT_SPACE');
    if (!run.pairs[p].setup) assert.equal(space.naForTrade, true, `${p} space should be naForTrade with no setup`);
  }
});

test('reduceEpisodes deduplicates a multi-candle armed run into one episode', () => {
  const tl = [
    { ms: T0 + 0 * M15, pairs: { EUR_USD: { decision: 'NO_TRADE_LATE', direction: 'BULLISH', strategy: null } } },
    { ms: T0 + 1 * M15, pairs: { EUR_USD: { decision: 'ARMED_BULLISH', direction: 'BULLISH', strategy: 'EARLY_EXPANSION' } } },
    { ms: T0 + 2 * M15, pairs: { EUR_USD: { decision: 'ARMED_BULLISH', direction: 'BULLISH', strategy: 'EARLY_EXPANSION' } } },
    { ms: T0 + 3 * M15, pairs: { EUR_USD: { decision: 'ARMED_BULLISH', direction: 'BULLISH', strategy: 'EARLY_EXPANSION' } } },
    { ms: T0 + 4 * M15, pairs: { EUR_USD: { decision: 'NO_TRADE_OVEREXTENDED', direction: 'BULLISH', strategy: null } } },
  ];
  const eps = reduceEpisodes(tl);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].ageCandles, 3);
  assert.equal(eps[0].firstMs, T0 + 1 * M15);
  assert.equal(eps[0].lastMs, T0 + 3 * M15);
  assert.equal(eps[0].endReason, 'invalidated:NO_TRADE_OVEREXTENDED');
});

test('reduceEpisodes: direction flip starts a new episode', () => {
  const tl = [
    { ms: T0, pairs: { GBP_USD: { decision: 'ARMED_BULLISH', direction: 'BULLISH', strategy: 'EARLY_EXPANSION' } } },
    { ms: T0 + M15, pairs: { GBP_USD: { decision: 'ARMED_BEARISH', direction: 'BEARISH', strategy: 'FAILED_EXPANSION_REVERSAL' } } },
  ];
  const eps = reduceEpisodes(tl);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].endReason, 'superseded');
});
