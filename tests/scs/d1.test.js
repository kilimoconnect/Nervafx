'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateD1 } = require('../../api/_scs-d1');

const DAY = 86400000;
let idx = 0;
const mk = (o, h, l, c) => ({ openMs: (idx++) * DAY, open: o, high: h, low: l, close: c });
const inside = () => mk(1.1000, 1.1010, 1.0990, 1.1000);   // stays within the band

test('close above the previous day high → BULLISH; previous day low protected', () => {
  idx = 0;
  const a = [inside(), inside(),
    mk(1.1000, 1.1030, 1.0995, 1.1025)]; // day 2 closes 1.1025 > day1 high 1.1010
  const st = evaluateD1(a);
  assert.equal(st.direction, 'BULLISH');
  assert.equal(st.bosLevel, 1.1010);       // previous day's high (the broken level)
  assert.equal(st.protectedLevel, 1.0990); // previous day's low
  assert.equal(st.invalidationReason, 'NONE');
});

test('close below the previous day low → BEARISH; previous day high protected', () => {
  idx = 0;
  const a = [inside(), inside(),
    mk(1.1000, 1.1005, 1.0970, 1.0975)]; // day 2 closes 1.0975 < day1 low 1.0990
  const st = evaluateD1(a);
  assert.equal(st.direction, 'BEARISH');
  assert.equal(st.bosLevel, 1.0990);       // previous day's low (the broken level)
  assert.equal(st.protectedLevel, 1.1010); // previous day's high
});

test('strong large-range breakout still confirms direction (no range gate on D1)', () => {
  idx = 0;
  const a = [inside(), inside(),
    mk(1.0990, 1.1100, 1.0980, 1.1080)]; // range ~120 pips, closes far above prev high
  assert.equal(evaluateD1(a).direction, 'BULLISH');
});

test('wick above previous high but close back inside → not a break', () => {
  idx = 0;
  const a = [inside(), inside(),
    mk(1.1000, 1.1030, 1.0995, 1.1005)]; // high 1.1030 pierces, close 1.1005 < prev high 1.1010
  assert.equal(evaluateD1(a).direction, 'NEUTRAL');
});

test('bullish then a close below the previous day low flips to BEARISH (stop & reverse)', () => {
  idx = 0;
  const a = [inside(), inside(),
    mk(1.1000, 1.1030, 1.0995, 1.1025),   // BULLISH
    mk(1.1025, 1.1035, 1.0990, 1.1030),   // higher, still bullish (protected raised to 1.0995)
    mk(1.1030, 1.1032, 1.0980, 1.0985)];  // closes below prev day low 1.0990 → BEARISH
  const st = evaluateD1(a);
  assert.equal(st.direction, 'BEARISH');
});

test('no break of a previous day high/low → NEUTRAL', () => {
  idx = 0;
  const a = [inside(), inside(), inside(), inside()];
  const st = evaluateD1(a);
  assert.equal(st.direction, 'NEUTRAL');
  assert.equal(st.invalidationReason, 'D1_NEUTRAL');
});
