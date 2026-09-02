'use strict';

const test = require('node:test');
const assert = require('node:assert');
const I = require('../../api/_scs-indicators');

const H1 = 3600000;
const c = (o, h, l, cl, i = 0) => ({ openMs: i * H1, open: o, high: h, low: l, close: cl });

test('ATR(14) Wilder converges to a constant true range', () => {
  const arr = [];
  for (let i = 0; i < 30; i++) arr.push(c(1.1000, 1.1010, 1.1000, 1.1000, i)); // TR = 0.0010 each (no gap)
  const atr = I.atrSeries(arr, 14);
  assert.equal(atr[12], null);                 // fewer than 14 candles
  assert.ok(Math.abs(atr[13] - 0.0010) < 1e-9);
  assert.ok(Math.abs(atr[29] - 0.0010) < 1e-9);
});

test('confirmed swing high needs 2 strictly-lower candles each side', () => {
  const arr = [c(0, 2, 0, 1, 0), c(0, 3, 0, 1, 1), c(0, 5, 0, 1, 2), c(0, 3, 0, 1, 3), c(0, 2, 0, 1, 4)];
  const hi = I.swingHighs(arr, 2, 2);
  assert.equal(hi.length, 1);
  assert.equal(hi[0].index, 2);
  assert.equal(hi[0].price, 5);
});

test('equal highs do NOT qualify (strict)', () => {
  const arr = [c(0, 2, 0, 1, 0), c(0, 5, 0, 1, 1), c(0, 5, 0, 1, 2), c(0, 5, 0, 1, 3), c(0, 2, 0, 1, 4)];
  assert.equal(I.swingHighs(arr, 2, 2).length, 0);
});

test('no repaint: a peak lacking 2 right candles is not yet confirmed', () => {
  // peak at index 3, only one candle to its right → not returned
  const arr = [c(0, 1, 0, 1, 0), c(0, 2, 0, 1, 1), c(0, 3, 0, 1, 2), c(0, 5, 0, 1, 3), c(0, 4, 0, 1, 4)];
  assert.equal(I.swingHighs(arr, 2, 2).length, 0);
  // once a 6th candle closes below, it confirms
  arr.push(c(0, 3, 0, 1, 5));
  const hi = I.swingHighs(arr, 2, 2);
  assert.equal(hi.length, 1); assert.equal(hi[0].index, 3);
});

const ATR = 0.0010;
const swingHi = { id: 'SH-1', time: 't', price: 1.1000 };
const swingLo = { id: 'SL-1', time: 't', price: 1.1000 };

test('bullish BOS: valid close beyond swing high', () => {
  const b = I.detectBOS(c(1.0998, 1.10130, 1.0997, 1.10120), swingHi, ATR, 1);
  assert.equal(b.bos, true); assert.equal(b.sweep, false); assert.equal(b.rejection, 'NONE');
  assert.ok(b.penetrationAtr >= 0.10 && b.bodyAtr >= 0.60 && b.closeLocation >= 0.75 && b.rangeAtr <= 2.0);
});

test('bearish BOS: valid close beyond swing low', () => {
  const b = I.detectBOS(c(1.10020, 1.10030, 1.09870, 1.09880), swingLo, ATR, -1);
  assert.equal(b.bos, true); assert.equal(b.rejection, 'NONE');
});

test('sweep, not BOS: wick beyond swing but close back inside', () => {
  const b = I.detectBOS(c(1.1001, 1.1005, 1.0998, 1.0999), swingHi, ATR, 1);
  assert.equal(b.bos, false); assert.equal(b.sweep, true); assert.equal(b.rejection, 'WICK_SWEEP_ONLY');
});

test('rejections: penetration / body / close-location / range', () => {
  assert.equal(I.detectBOS(c(1.0999, 1.10010, 1.0998, 1.10005), swingHi, ATR, 1).rejection, 'PENETRATION_TOO_SMALL');
  assert.equal(I.detectBOS(c(1.10018, 1.10025, 1.10015, 1.10020), swingHi, ATR, 1).rejection, 'BODY_TOO_SMALL');
  assert.equal(I.detectBOS(c(1.09920, 1.10080, 1.09900, 1.10020), swingHi, ATR, 1).rejection, 'CLOSE_LOCATION_WEAK');
  assert.equal(I.detectBOS(c(1.10000, 1.10130, 1.09900, 1.10120), swingHi, ATR, 1).rejection, 'RANGE_TOO_LARGE');
});

test('latestSwingBefore returns the most recent qualifying swing', () => {
  const sw = [{ index: 1 }, { index: 4 }, { index: 6 }];
  assert.equal(I.latestSwingBefore(sw, 5).index, 4);
  assert.equal(I.latestSwingBefore(sw, 2).index, 1);
  assert.equal(I.latestSwingBefore(sw, 1), null);
});
