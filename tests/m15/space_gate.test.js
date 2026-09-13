'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decide } = require('../../api/_m15/strategy');
const { CONFIG } = require('../../api/_m15/config');
const { CONFIG_1_1_0 } = require('../../api/_m15/config-1_1_0');

// Minimal armed-eligible context; override per case.
function ctx(over = {}) {
  return {
    pair: 'EUR_USD',
    marketState: { state: 'BULLISH_EXPANSION', pullback: null },
    energy: { energyAcceleration: 'RISING', energyLevel: 'ACTIVE', energyDirection: 'BULLISH' },
    freshness: { state: 'FRESH' },
    expansion: { state: 'EARLY', direction: 'BULLISH', focus: true, spaceSufficient: true, availableSpaceVol: 6, distanceVol: 1.0 },
    compression: { state: 'NONE' },
    pressure: { pressureState: 'BULLISH_BUILDING' },
    movement: { direction: 'BULLISH', stage: 'ACTIVE', velocity: 1, acceleration: 1, efficiency: 0.6 },
    eq: { volNow: 0.001, price: 1.1000, distanceVol: 1.0 },
    structure: { current: { extreme: 1.1010, pivot: 1.0990 }, legs: [] },
    agreement: { state: 'STRONG_BULLISH', reasons: [], gateFailures: [] },
    ...over,
  };
}
const base = (c) => decide(c, { cfg: CONFIG });
const cand = (c) => decide(c, { cfg: CONFIG_1_1_0 });

test('baseline still reproduces: ample space ⇒ ARMED (both configs)', () => {
  assert.equal(base(ctx()).decision, 'ARMED_BULLISH');
  assert.equal(cand(ctx()).decision, 'ARMED_BULLISH');   // availableSpaceVol=6 ⇒ open room
});

test('candidate: a real candidate with < 1R room to the barrier ⇒ INSUFFICIENT_SPACE', () => {
  // barrier 0.5 vol ahead, risk ≈ 0.0027 ⇒ roomR ≈ 0.19R < 1
  const c = ctx({ expansion: { state: 'EARLY', direction: 'BULLISH', focus: true, spaceSufficient: false, availableSpaceVol: 0.5, distanceVol: 1.0 } });
  assert.equal(cand(c).decision, 'NO_TRADE_INSUFFICIENT_SPACE');
  assert.equal(cand(c).setup, null);
});

test('candidate: ample room to the barrier ⇒ ARMED even though legacy availableSpaceVol flag is false', () => {
  // 4 vol ahead, risk ≈ 0.0027 ⇒ roomR ≈ 1.48R ≥ 1
  const c = ctx({ expansion: { state: 'EARLY', direction: 'BULLISH', focus: true, spaceSufficient: false, availableSpaceVol: 4, distanceVol: 1.0 } });
  assert.equal(cand(c).decision, 'ARMED_BULLISH');
});

test('NO candidate ⇒ candidate never calls it INSUFFICIENT_SPACE (relabels to the real reason)', () => {
  // No strategy routes (TRANSITION / NONE), agreement absent; legacy pre-gate fires on space.
  const c = ctx({ marketState: { state: 'TRANSITION' }, expansion: { state: 'NONE', direction: 'NEUTRAL', focus: false, spaceSufficient: false, availableSpaceVol: 0.1 }, agreement: { state: 'NO_AGREEMENT', reasons: [], gateFailures: [] } });
  assert.equal(base(c).decision, 'NO_TRADE_INSUFFICIENT_SPACE');       // legacy: shown as space
  assert.notEqual(cand(c).decision, 'NO_TRADE_INSUFFICIENT_SPACE');    // candidate: not space (no trade exists)
  assert.equal(cand(c).decision, 'NO_TRADE_CONFLICTED');               // its true reason
});

test('undefined-risk candidate stays BLOCKED, never ARMED (per_trade invariant)', () => {
  const c = ctx({ structure: null });   // buildSetup returns null ⇒ no valid entry/stop
  assert.ok(/^ARMED_/.test(base(c).decision));            // legacy quirk: armed without a setup
  assert.ok(!/^ARMED_/.test(cand(c).decision));           // candidate: must not be armed
  assert.equal(cand(c).setup, null);
});

test('market-state transition changes routing: DEVELOPED expansion does not arm', () => {
  const c = ctx({ expansion: { state: 'DEVELOPED', direction: 'BULLISH', focus: false, spaceSufficient: true, availableSpaceVol: 6, distanceVol: 2.6 } });
  assert.ok(!/^ARMED_/.test(cand(c).decision));   // notOver=false ⇒ strategy B not routed
});

test('non-space rejections are identical across configs (only space application changed)', () => {
  for (const st of ['DEAD', 'CHAOTIC']) {
    const c = ctx({ marketState: { state: st } });
    assert.equal(base(c).decision, cand(c).decision, `${st} must be identical`);
  }
  // CONFLICTED agreement is identical too
  const cc = ctx({ agreement: { state: 'CONFLICTED', reasons: [], gateFailures: [] } });
  assert.equal(base(cc).decision, cand(cc).decision);
});
