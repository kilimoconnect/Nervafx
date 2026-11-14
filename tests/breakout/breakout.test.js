'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyBreak, latestBreak, isBullishBreak, isBearishBreak } = require('../../research/breakout/breakout');
const { candles } = require('./fixtures');

test('bullish break: close strictly above the previous high', () => {
  const cs = candles([{ o: 10, h: 11, l: 9, c: 10.5 }, { o: 10.5, h: 11.4, l: 10.2, c: 11.3 }]);
  assert.ok(isBullishBreak(cs[1], cs[0]));                     // 11.3 > 11
  const b = latestBreak(cs);
  assert.equal(b.direction, 1);
  assert.equal(b.brokenBoundary, 'high');
  assert.equal(b.brokenLevel, 11);
  assert.equal(b.ageCandles, 0);
});

test('bearish break: close strictly below the previous low', () => {
  const cs = candles([{ o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 10.1, l: 8.5, c: 8.8 }]);
  assert.ok(isBearishBreak(cs[1], cs[0]));                     // 8.8 < 9
  const b = latestBreak(cs);
  assert.equal(b.direction, -1);
  assert.equal(b.brokenBoundary, 'low');
  assert.equal(b.brokenLevel, 9);
});

test('boundary equality does NOT qualify (close exactly on the prior high/low)', () => {
  const up = candles([{ o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 11.2, l: 9.5, c: 11 }]);   // close == prev high
  assert.equal(classifyBreak(up[1], up[0]).direction, 0);
  const dn = candles([{ o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 10.1, l: 8.8, c: 9 }]);     // close == prev low
  assert.equal(classifyBreak(dn[1], dn[0]).direction, 0);
});

test('a wick beyond the boundary without a close beyond it does NOT qualify', () => {
  // high pierces prev high (11.5 > 11) but the candle closes back inside at 10.8
  const cs = candles([{ o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 11.5, l: 9.8, c: 10.8 }]);
  assert.equal(classifyBreak(cs[1], cs[0]).direction, 0);
  assert.equal(latestBreak(cs).direction, 0);
});

test('persistence: with no new break, the latest prior break is retained (no expiry)', () => {
  // break up at idx1, then 5 inside candles that never break again
  const cs = candles([
    { o: 10, h: 11, l: 9, c: 10 },
    { o: 10, h: 11.6, l: 10, c: 11.4 },                        // bullish break (level 11)
    { o: 11.4, h: 11.5, l: 11.0, c: 11.2 },
    { o: 11.2, h: 11.45, l: 11.0, c: 11.1 },
    { o: 11.1, h: 11.5, l: 10.9, c: 11.3 },                    // high 11.5 == running but close 11.3 < prev high 11.45? prev=11.45 → no break
    { o: 11.3, h: 11.4, l: 11.1, c: 11.2 },
    { o: 11.2, h: 11.4, l: 11.0, c: 11.25 },
  ]);
  const b = latestBreak(cs);
  assert.equal(b.direction, 1, 'direction still bullish from the old break');
  assert.equal(b.breakIdx, 1, 'points at the original break candle');
  assert.equal(b.ageCandles, 5, 'break is 5 completed candles old but still valid');
});

test('same-direction newer break updates the break details, direction unchanged', () => {
  const cs = candles([
    { o: 10, h: 11, l: 9, c: 10 },
    { o: 10, h: 11.6, l: 10, c: 11.4 },                        // bullish break #1 (level 11)
    { o: 11.4, h: 11.5, l: 11.1, c: 11.2 },
    { o: 11.2, h: 12.0, l: 11.1, c: 11.9 },                    // bullish break #2 (level 11.5 = prev high)
  ]);
  const b = latestBreak(cs);
  assert.equal(b.direction, 1);
  assert.equal(b.breakIdx, 3, 'latest (most recent) break wins');
  assert.equal(b.brokenLevel, 11.5);
});

test('reversal: a later bearish break flips the direction', () => {
  const cs = candles([
    { o: 10, h: 11, l: 9, c: 10 },
    { o: 10, h: 11.6, l: 10, c: 11.4 },                        // bullish break (prev low here = 10)
    { o: 11.4, h: 11.5, l: 9.8, c: 9.9 },                      // close 9.9 < prev low 10 → bearish break
  ]);
  const b = latestBreak(cs);
  assert.equal(b.direction, -1);
  assert.equal(b.brokenBoundary, 'low');
  assert.equal(b.brokenLevel, 10);
});

test('insufficient history: fewer than two completed candles', () => {
  assert.equal(latestBreak([]).reason, 'insufficient-history');
  assert.equal(latestBreak(candles([{ o: 10, h: 11, l: 9, c: 10 }])).reason, 'insufficient-history');
});

test('no qualifying break anywhere in available history → unknown (0)', () => {
  const cs = candles([
    { o: 10, h: 11, l: 9, c: 10.2 },
    { o: 10.2, h: 10.9, l: 9.2, c: 10.1 },                     // inside
    { o: 10.1, h: 10.8, l: 9.3, c: 10.0 },                     // inside
  ]);
  const b = latestBreak(cs);
  assert.equal(b.direction, 0);
  assert.equal(b.reason, 'no-break-in-history');
});
