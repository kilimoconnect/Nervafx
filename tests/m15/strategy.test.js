'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateMarketState } = require('../../api/_m15/marketState');
const { routeStrategy, decide, STRATEGY } = require('../../api/_m15/strategy');
const { evaluateTrigger } = require('../../api/_m15/triggers');

// ── Market state ─────────────────────────────────────────────────────────────
test('market state precedence: dead / chaotic / expansion / exhaustion / failed / pullback', () => {
  assert.equal(evaluateMarketState({ energy: { energyLevel: 'DEAD', energyDirection: 'BALANCED' } }).state, 'DEAD');
  assert.equal(evaluateMarketState({ energy: { energyLevel: 'STRONG', energyDirection: 'CHAOTIC' } }).state, 'CHAOTIC');
  assert.equal(evaluateMarketState({ energy: { energyLevel: 'ACTIVE', energyDirection: 'BULLISH' }, expansion: { state: 'EARLY', direction: 'BULLISH' }, movement: { direction: 'BULLISH' } }).state, 'BULLISH_EXPANSION');
  assert.equal(evaluateMarketState({ energy: { energyLevel: 'ACTIVE' }, expansion: { state: 'OVEREXTENDED', direction: 'BULLISH' }, movement: { direction: 'BULLISH' } }).state, 'BULLISH_EXHAUSTION');
  assert.equal(evaluateMarketState({ energy: { energyLevel: 'ACTIVE' }, expansion: { state: 'FAILED', direction: 'BEARISH' }, movement: { direction: 'BEARISH' } }).state, 'FAILED_BEARISH_EXPANSION');
  const pb = evaluateMarketState({
    energy: { energyLevel: 'ACTIVE' }, movement: { direction: 'BEARISH' }, expansion: { state: 'ATTEMPTING', direction: 'BEARISH' },
    structure: { current: { direction: 'DOWN', displacement: 0.001 }, legs: [{ direction: 'UP', displacement: 0.004 }] },
  });
  assert.equal(pb.state, 'BULLISH_PULLBACK');
});

// ── Strategy router ──────────────────────────────────────────────────────────
test('router picks exactly one strategy by market state', () => {
  const A = routeStrategy({ marketState: { state: 'COMPRESSION' }, compression: { state: 'TIGHT' }, pressure: { pressureState: 'BULLISH_BUILDING' }, energy: { energyAcceleration: 'RISING' }, expansion: { state: 'ATTEMPTING' } });
  assert.equal(A, STRATEGY.A);
  const B = routeStrategy({ marketState: { state: 'BULLISH_EXPANSION' }, expansion: { state: 'EARLY', spaceSufficient: true }, freshness: { state: 'FRESH' } });
  assert.equal(B, STRATEGY.B);
  const C = routeStrategy({ marketState: { state: 'BULLISH_PULLBACK', pullback: { isPullback: true } }, freshness: { state: 'TRADEABLE' } });
  assert.equal(C, STRATEGY.C);
  const D = routeStrategy({ marketState: { state: 'FAILED_BULLISH_EXPANSION' }, expansion: { state: 'FAILED' } });
  assert.equal(D, STRATEGY.D);
});

// ── Decision + setup ─────────────────────────────────────────────────────────
function armedCtx(dir = 'BULLISH') {
  return {
    pair: 'EUR_USD',
    marketState: { state: 'BULLISH_EXPANSION', pullback: { isPullback: false } },
    agreement: { state: 'STRONG_BULLISH', reasons: ['aligned'], gateFailures: [] },
    energy: { energyLevel: 'ACTIVE', energyAcceleration: 'RISING' },
    expansion: { state: 'EARLY', direction: 'BULLISH', spaceSufficient: true, availableSpaceVol: 4 },
    freshness: { state: 'FRESH' },
    eq: { price: 1.10500, volNow: 0.00050 },
    structure: { current: { direction: 'UP', extreme: 1.10520, pivot: 1.10300 } },
  };
}

test('armed bullish setup has correctly ordered levels and 2R targets (§24)', () => {
  const r = decide(armedCtx());
  assert.equal(r.decision, 'ARMED_BULLISH');
  assert.equal(r.strategy, STRATEGY.B);
  const s = r.setup;
  assert.ok(s.stopPrice < s.triggerPrice, 'stop below trigger for a buy');
  assert.ok(s.target1 > s.triggerPrice && s.target2 > s.target1, 'targets above trigger, ordered');
  assert.ok(s.stopPips > 0);
  assert.equal(s.rr, 2);
  // R multiple check: (target2 - trigger) ≈ 2 × (trigger - stop)
  const risk = s.triggerPrice - s.stopPrice, reward2 = s.target2 - s.triggerPrice;
  assert.ok(Math.abs(reward2 / risk - 2) < 0.05);
});

test('hard NO-TRADE decisions (§25)', () => {
  assert.equal(decide({ marketState: { state: 'DEAD' } }).decision, 'NO_TRADE_DEAD');
  assert.equal(decide({ marketState: { state: 'CHAOTIC' } }).decision, 'NO_TRADE_CHAOTIC');
  assert.equal(decide({ marketState: { state: 'BULLISH_EXPANSION' }, agreement: { state: 'CONFLICTED' } }).decision, 'NO_TRADE_CONFLICTED');
  assert.equal(decide({ marketState: { state: 'BULLISH_EXPANSION' }, freshness: { state: 'LATE' } }).decision, 'NO_TRADE_LATE');
  assert.equal(decide({ marketState: { state: 'BULLISH_EXPANSION' }, expansion: { state: 'OVEREXTENDED' } }).decision, 'NO_TRADE_OVEREXTENDED');
});

// ── Manual triggers ──────────────────────────────────────────────────────────
const buySetup = { pair: 'EUR_USD', strategy: STRATEGY.B, direction: 'BULLISH', triggerPrice: 1.10550, invalidationPrice: 1.10300 };

test('manual trigger raises a NOTIFICATION only — never an order (§24, §32)', () => {
  const hit = evaluateTrigger(buySetup, { bid: 1.10548, ask: 1.10552, timeMs: 1000 });
  assert.equal(hit.status, 'MANUAL_BUY_OPPORTUNITY');
  // The result is a notification: no order id, side, size, or execution field.
  for (const k of ['orderId', 'order', 'ticket', 'lots', 'size', 'volume', 'executed', 'filled']) {
    assert.ok(!(k in hit), `trigger result must not contain '${k}'`);
  }
});

test('buy triggers on ASK, sell triggers on BID', () => {
  assert.equal(evaluateTrigger(buySetup, { bid: 1.10500, ask: 1.10505 }).status, 'PENDING'); // ask below trigger
  const sell = { pair: 'EUR_USD', strategy: STRATEGY.B, direction: 'BEARISH', triggerPrice: 1.10000, invalidationPrice: 1.10300 };
  assert.equal(evaluateTrigger(sell, { bid: 1.09999, ask: 1.10002 }).status, 'MANUAL_SELL_OPPORTUNITY');
});

test('invalidation and expiry take precedence over triggering', () => {
  assert.equal(evaluateTrigger(buySetup, { bid: 1.10250, ask: 1.10260 }).status, 'INVALIDATED');
  assert.equal(evaluateTrigger(buySetup, { bid: 1.10560, ask: 1.10565, timeMs: 5000 }, { expiresAtMs: 4000 }).status, 'EXPIRED');
});
