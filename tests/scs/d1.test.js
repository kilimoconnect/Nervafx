'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateD1 } = require('../../api/_scs-d1');

const DAY = 86400000;
let idx = 0;
const mk = (o, h, l, c) => ({ openMs: (idx++) * DAY, open: o, high: h, low: l, close: c });
const inside = () => mk(1.1000, 1.1010, 1.0990, 1.1000);

test('last completed candle closes above the previous day high → BULLISH (protect prev low)', () => {
  idx = 0;
  const a = [inside(), mk(1.1000, 1.1030, 1.0995, 1.1025)]; // day1 closes 1.1025 > day0 high 1.1010
  const st = evaluateD1(a);
  assert.equal(st.direction, 'BULLISH');
  assert.equal(st.bosLevel, 1.1010);       // previous day's high (broken)
  assert.equal(st.protectedLevel, 1.0990); // previous day's low
});

test('last completed candle closes below the previous day low → BEARISH (protect prev high)', () => {
  idx = 0;
  const a = [inside(), mk(1.1000, 1.1005, 1.0970, 1.0975)]; // closes 1.0975 < day0 low 1.0990
  const st = evaluateD1(a);
  assert.equal(st.direction, 'BEARISH');
  assert.equal(st.bosLevel, 1.0990);
  assert.equal(st.protectedLevel, 1.1010);
});

test('inside day (no break) → NEUTRAL', () => {
  idx = 0;
  const a = [inside(), mk(1.1000, 1.1008, 1.0992, 1.1001)]; // stays within day0 range
  assert.equal(evaluateD1(a).direction, 'NEUTRAL');
});

test('wick beyond previous high but close back inside → NEUTRAL (close required)', () => {
  idx = 0;
  const a = [inside(), mk(1.1000, 1.1030, 1.0995, 1.1005)]; // high pierces 1.1010, close 1.1005 < 1.1010
  assert.equal(evaluateD1(a).direction, 'NEUTRAL');
});

test('only the most recent completed candle vs the day before decides (older breaks ignored)', () => {
  idx = 0;
  const a = [
    inside(),
    mk(1.1000, 1.1030, 1.0995, 1.1025),   // an earlier bullish break …
    mk(1.1025, 1.1035, 1.0990, 1.1030),   // penultimate day
    mk(1.1030, 1.1034, 1.1005, 1.1020),   // LAST completed: inside the penultimate day's range → NEUTRAL
  ];
  const st = evaluateD1(a);
  assert.equal(st.direction, 'NEUTRAL');
  // reference = last completed day, previous = the day before it
  assert.equal(st.referenceDay != null, true);
});

test('reference is the last completed candle; bias flips with that candle', () => {
  idx = 0;
  const bull = [inside(), mk(1.1000, 1.1030, 1.0995, 1.1025)];
  assert.equal(evaluateD1(bull).direction, 'BULLISH');
  idx = 0;
  const bear = [inside(), mk(1.1000, 1.1005, 1.0970, 1.0975)];
  assert.equal(evaluateD1(bear).direction, 'BEARISH');
});

test('fewer than two completed days → NEUTRAL', () => {
  idx = 0;
  assert.equal(evaluateD1([inside()]).direction, 'NEUTRAL');
  assert.equal(evaluateD1([]).direction, 'NEUTRAL');
});
