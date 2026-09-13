'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateCurrencyStructure } = require('../../api/_m15/currencyStructure');
const { evaluateAgreement } = require('../../api/_m15/agreement');
const { PAIRS } = require('../../api/_m15/pairs');

const perPairAll = (fn) => Object.fromEntries(PAIRS.map((p) => [p, fn(p)]));

test('currency structure: USD broadly bullish ⇒ BROAD_BULLISH_* with broad participation', () => {
  const perPair = perPairAll((p) => {
    const [b, q] = p.split('_');
    if (b === 'USD') return { direction: 'BULLISH', expansionState: 'EARLY', freshness: 'FRESH', movementStage: 'ACTIVE' };
    if (q === 'USD') return { direction: 'BEARISH', expansionState: 'EARLY', freshness: 'FRESH', movementStage: 'ACTIVE' };
    return { direction: 'NEUTRAL' };
  });
  const usd = evaluateCurrencyStructure(perPair).byCurrency['USD'];
  assert.equal(usd.direction, 'BULLISH');
  assert.ok(usd.state.startsWith('BROAD_BULLISH'));
  assert.equal(usd.participation, 'BROAD');
  assert.ok(usd.supportingPairs.length >= 6);
});

test('currency structure: moving against one weak counterpart ⇒ CONCENTRATED / MIXED', () => {
  const perPair = perPairAll((p) => (p === 'EUR_USD' ? { direction: 'BEARISH' } : { direction: 'NEUTRAL' }));
  const usd = evaluateCurrencyStructure(perPair).byCurrency['USD'];
  assert.equal(usd.participation, 'CONCENTRATED');
  assert.ok(['MIXED', 'NEUTRAL'].includes(usd.state));
});

test('currency structure: late/exhausted majority ⇒ EXHAUSTED', () => {
  const perPair = perPairAll((p) => {
    const [b, q] = p.split('_');
    if (b === 'USD') return { direction: 'BULLISH', freshness: 'EXHAUSTED', movementStage: 'EXHAUSTING' };
    if (q === 'USD') return { direction: 'BEARISH', freshness: 'EXHAUSTED', movementStage: 'EXHAUSTING' };
    return { direction: 'NEUTRAL' };
  });
  assert.equal(evaluateCurrencyStructure(perPair).byCurrency['USD'].state, 'EXHAUSTED');
});

// ── Agreement ───────────────────────────────────────────────────────────────
function bullCtx(overrides = {}) {
  return Object.assign({
    pair: 'EUR_USD',
    gates: { dataComplete: true, synchronized: true, spreadPips: 0.8, spreadCapPips: 2.5, noCriticalNews: true },
    movement: { direction: 'BULLISH' },
    ema: { state: 'EARLY_BULLISH_TURN' },
    pressure: { pressureState: 'BULLISH_BUILDING', pressureDirection: 'BULLISH' },
    expansion: { state: 'EARLY', direction: 'BULLISH', focus: true, spaceSufficient: true },
    energy: { energyLevel: 'ACTIVE', energyDirection: 'BULLISH' },
    freshness: { state: 'FRESH' },
    strengthDiff: 40, baseStrengthAccel: 5, quoteStrengthAccel: -5,
    basePower: { powerDirection: 'BULLISH', powerScore: 70 }, quotePower: { powerDirection: 'BEARISH', powerScore: 60 },
    baseStructure: { direction: 'BULLISH', breadth: 0.8 }, quoteStructure: { direction: 'BEARISH', breadth: 0.8 },
  }, overrides);
}

test('agreement: aligned fresh bullish evidence ⇒ STRONG/BUILDING bullish, gates pass', () => {
  const r = evaluateAgreement(bullCtx());
  assert.ok(['STRONG_BULLISH', 'BULLISH_BUILDING'].includes(r.state), `got ${r.state}`);
  assert.equal(r.gatesPassed, true);
  assert.ok(r.reasons.length > 0);
});

test('agreement gate: wide spread ⇒ NO_AGREEMENT regardless of direction (§21)', () => {
  const r = evaluateAgreement(bullCtx({ gates: { dataComplete: true, synchronized: true, spreadPips: 9, spreadCapPips: 2.5, noCriticalNews: true } }));
  assert.equal(r.state, 'NO_AGREEMENT');
  assert.ok(r.gateFailures.some((x) => /spread/.test(x)));
});

test('agreement gate: dead/chaotic energy ⇒ NO_AGREEMENT', () => {
  assert.equal(evaluateAgreement(bullCtx({ energy: { energyLevel: 'DEAD', energyDirection: 'BALANCED' } })).state, 'NO_AGREEMENT');
  assert.equal(evaluateAgreement(bullCtx({ energy: { energyLevel: 'STRONG', energyDirection: 'CHAOTIC' } })).state, 'NO_AGREEMENT');
});

test('agreement: strong but LATE ⇒ LATE, not a bullish grade (§22/§32)', () => {
  const r = evaluateAgreement(bullCtx({ freshness: { state: 'LATE' } }));
  assert.equal(r.state, 'LATE');
});

test('agreement: overextended ⇒ NO_AGREEMENT even with aligned direction', () => {
  const r = evaluateAgreement(bullCtx({ expansion: { state: 'OVEREXTENDED', direction: 'BULLISH', focus: false, spaceSufficient: true } }));
  assert.equal(r.state, 'NO_AGREEMENT');
});

test('agreement: genuinely balanced evidence ⇒ CONFLICTED', () => {
  const r = evaluateAgreement(bullCtx({
    movement: { direction: 'BULLISH' },                 // +
    ema: { state: 'BEARISH_ESTABLISHED' },              // −
    pressure: { pressureState: 'BULLISH_DOMINANT' },    // +
    basePower: { powerDirection: 'BEARISH', powerScore: 60 }, quotePower: { powerDirection: 'BULLISH', powerScore: 60 }, // −
    baseStructure: { direction: 'BULLISH', breadth: 0.8 }, quoteStructure: { direction: 'BULLISH', breadth: 0.8 },       // net 0
    energy: { energyLevel: 'ACTIVE', energyDirection: 'BEARISH' }, // −
    strengthDiff: 0, baseStrengthAccel: 5, quoteStrengthAccel: 5,  // 0
    expansion: { state: 'EARLY', direction: 'BULLISH', focus: true, spaceSufficient: true }, // +
  }));
  assert.equal(r.state, 'CONFLICTED');
});

test('agreement: components are stored separately with reasons (§21)', () => {
  const r = evaluateAgreement(bullCtx());
  assert.ok(Array.isArray(r.components) && r.components.length >= 8);
  for (const c of r.components) { assert.ok(typeof c.name === 'string'); assert.ok(typeof c.reason === 'string'); }
});
