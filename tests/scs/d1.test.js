'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateD1 } = require('../../api/_scs-d1');

const DAY = 86400000;
let idx = 0;
const mk = (o, h, l, c) => ({ openMs: (idx++) * DAY, open: o, high: h, low: l, close: c });
const doji = () => mk(1.0990, 1.0995, 1.0985, 1.0990);

// 14 warm-up dojis → ATR≈0.0010, no swings (equal highs/lows never qualify)
function base() {
  idx = 0;
  const a = [];
  for (let i = 0; i < 14; i++) a.push(doji());
  a.push(mk(1.0990, 1.0995, 1.0980, 1.0990)); // 14: swing low @1.0980
  a.push(doji()); a.push(doji());             // 15,16
  a.push(mk(1.0990, 1.1000, 1.0985, 1.0990)); // 17: swing high @1.1000
  a.push(doji()); a.push(doji());             // 18,19
  a.push(mk(1.10000, 1.10130, 1.09995, 1.10120)); // 20: valid bullish D1 BOS above 1.1000
  return a;
}

test('valid bullish D1 BOS → BULLISH with the responsible swing low protected', () => {
  const st = evaluateD1(base());
  assert.equal(st.direction, 'BULLISH');
  assert.equal(st.protectedLevel, 1.0980);
  assert.ok(st.protectedSwingId.startsWith('SL-'));
  assert.equal(st.bosLevel, 1.1000);
  assert.equal(st.invalidationReason, 'NONE');
});

test('completed close below protected low (no opposite BOS) → NEUTRAL', () => {
  const a = base();
  a.push(mk(1.0979, 1.0982, 1.0977, 1.0978)); // 21: closes below 1.0980, weak body → no bearish BOS
  const st = evaluateD1(a);
  assert.equal(st.direction, 'NEUTRAL');
  assert.equal(st.invalidationReason, 'D1_PROTECTED_BROKEN');
});

test('wick below protected but close above → stays BULLISH (wicks never invalidate)', () => {
  const a = base();
  a.push(mk(1.0985, 1.0990, 1.0975, 1.0985)); // 21: low pierces 1.0980 but closes above
  const st = evaluateD1(a);
  assert.equal(st.direction, 'BULLISH');
  assert.equal(st.protectedLevel, 1.0980);
});

test('no directional BOS → NEUTRAL (D1_NEUTRAL)', () => {
  idx = 0;
  const flat = []; for (let i = 0; i < 20; i++) flat.push(doji());
  const st = evaluateD1(flat);
  assert.equal(st.direction, 'NEUTRAL');
  assert.equal(st.invalidationReason, 'D1_NEUTRAL');
});
