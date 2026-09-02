'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateH4, classifyOrigin } = require('../../api/_scs-h4');

const H4 = 4 * 3600000;
const BULL = { direction: 'BULLISH' };
const NEUTRAL = { direction: 'NEUTRAL' };
// H4 candles aligned to real 4h boundaries from Sun 2026-07-19 21:00 UTC (17:00 NY reopen)
const BASE = Date.UTC(2026, 6, 19, 21, 0);
let idx = 0;
const mk = (o, h, l, c) => ({ openMs: BASE + (idx++) * H4, open: o, high: h, low: l, close: c });
const doji = () => mk(1.0990, 1.0995, 1.0985, 1.0990);
const evalOf = (arr) => arr[arr.length - 1].openMs + H4;

// warm-up + swing low@14 + swing high@17 + bullish BOS@20
function base() {
  idx = 0;
  const a = [];
  for (let i = 0; i < 14; i++) a.push(doji());
  a.push(mk(1.0990, 1.0995, 1.0980, 1.0990)); // 14: swing low @1.0980
  a.push(doji()); a.push(doji());
  a.push(mk(1.0990, 1.1000, 1.0985, 1.0990)); // 17: swing high @1.1000
  a.push(doji()); a.push(doji());
  a.push(mk(1.10000, 1.10130, 1.09995, 1.10120)); // 20: bullish H4 BOS
  return a;
}

test('D1 neutral → NO_IMPULSE', () => {
  const r = evaluateH4(base(), NEUTRAL, evalOf(base()));
  assert.equal(r.state, 'NO_IMPULSE');
  assert.equal(r.invalidationReason, 'H4_D1_MISALIGNED');
});

test('aligned bullish BOS → IMPULSE_ACTIVE with protected low & extreme', () => {
  const a = base();
  const r = evaluateH4(a, BULL, evalOf(a));
  assert.equal(r.state, 'IMPULSE_ACTIVE');
  assert.equal(r.impulse.protectedLevel, 1.0980);
  assert.equal(r.impulse.extreme, 1.10130);
  assert.equal(r.impulse.ageCandles, 0);
});

test('counter candle + ≥0.5 H4-ATR retrace → PULLBACK_ACTIVE', () => {
  const a = base();
  a.push(mk(1.10120, 1.10125, 1.10070, 1.10075)); // 21: bearish, retrace ~0.0006 (≥0.5 ATR)
  const r = evaluateH4(a, BULL, evalOf(a));
  assert.equal(r.state, 'PULLBACK_ACTIVE');
  assert.ok(r.impulse.pullbackDepthAtr >= 0.5);
});

test('age beyond 12 completed H4 candles → EXPIRED', () => {
  const a = base();
  for (let i = 0; i < 13; i++) a.push(mk(1.1010, 1.1012, 1.1008, 1.1010)); // dojis, no new BOS, no break
  const r = evaluateH4(a, BULL, evalOf(a));
  assert.equal(r.state, 'EXPIRED');
  assert.ok(r.impulse.ageCandles > 12);
});

test('close below protected level → INVALIDATED', () => {
  const a = base();
  a.push(mk(1.0985, 1.0990, 1.0975, 1.0978)); // 21: closes below protected 1.0980
  const r = evaluateH4(a, BULL, evalOf(a));
  assert.equal(r.state, 'INVALIDATED');
  assert.equal(r.invalidationReason, 'H4_PROTECTED_BROKEN');
});

test('origin classification: CURRENT / PREVIOUS / FRIDAY_CARRY', () => {
  const monMorning = Date.UTC(2026, 6, 20, 2, 0);   // Mon session (Sun 21:00 start)
  const monLater = Date.UTC(2026, 6, 20, 10, 0);
  assert.equal(classifyOrigin(monMorning, monLater + 1), 'CURRENT_DAY');
  const tueEval = Date.UTC(2026, 6, 21, 10, 0);      // Tuesday session
  assert.equal(classifyOrigin(monMorning, tueEval + 1), 'PREVIOUS_DAY');
  const friImpulse = Date.UTC(2026, 6, 24, 10, 0);   // Friday trading day (Thu 17:00 NY start)
  const monEval = Date.UTC(2026, 6, 27, 10, 0);      // following Monday
  assert.equal(classifyOrigin(friImpulse, monEval + 1), 'FRIDAY_CARRY');
});
