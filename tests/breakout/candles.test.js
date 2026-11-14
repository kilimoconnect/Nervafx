'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { aggregateEat, completedAsOf, completedTf, normaliseH1 } = require('../../research/breakout/candles');
const { dayStart, h4Start } = require('../../research/comparison/periods');

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
// T = a real EAT day start (00:00 EAT = 21:00 UTC the prior day)
const T = dayStart(Date.UTC(2026, 0, 2, 12, 0, 0));

function h1(offsetHours, o, h, l, c, v) {
  return { openMs: T + offsetHours * HOUR, open: o, high: h, low: l, close: c, volume: v };
}

test('H1 pass-through adds closeMs only', () => {
  const rows = normaliseH1([h1(0, 10, 11, 9, 10.5, 7)]);
  assert.equal(rows[0].openMs, T);
  assert.equal(rows[0].closeMs, T + HOUR);
  assert.equal(rows[0].close, 10.5);
  assert.equal(rows[0].volume, 7);
});

test('H1 → D1 EAT aggregation rolls up OHLC and sums volume per EAT day', () => {
  const h1rows = [
    h1(0, 10, 12, 9, 11, 100),
    h1(1, 11, 13, 10, 12, 50),
    h1(2, 12, 12.5, 11, 11.5, 30),   // day A (closes T+24h)
    h1(24, 11.5, 14, 11, 13, 200),
    h1(25, 13, 13.5, 12, 12.5, 40),  // day B (closes T+48h)
  ];
  const d1 = aggregateEat(h1rows, 'D1');
  assert.equal(d1.length, 2);
  assert.deepEqual(
    { o: d1[0].open, h: d1[0].high, l: d1[0].low, c: d1[0].close, v: d1[0].volume, open: d1[0].openMs, close: d1[0].closeMs },
    { o: 10, h: 13, l: 9, c: 11.5, v: 180, open: T, close: T + DAY },
  );
  assert.deepEqual(
    { o: d1[1].open, h: d1[1].high, l: d1[1].low, c: d1[1].close, v: d1[1].volume },
    { o: 11.5, h: 14, l: 11, c: 12.5, v: 240 },
  );
});

test('completedAsOf drops the still-forming final bucket (no look-ahead)', () => {
  const h1rows = [h1(0, 10, 12, 9, 11), h1(1, 11, 13, 10, 12), h1(24, 11.5, 14, 11, 13)];
  // asOf exactly at day A's close → day A complete, day B forming → dropped
  const got = completedTf(h1rows, 'D1', T + DAY);
  assert.equal(got.length, 1);
  assert.equal(got[0].openMs, T);
  // one hour later, still before day B closes → still just day A
  assert.equal(completedTf(h1rows, 'D1', T + DAY + HOUR).length, 1);
  // with no cutoff, both buckets are returned
  assert.equal(aggregateEat(h1rows, 'D1').length, 2);
});

test('H4 EAT aggregation buckets to 00/04/08/12/16/20 EAT', () => {
  // six H1 candles starting at an EAT H4 boundary → first four in bucket 1, next two in bucket 2
  const base = h4Start(T + 30 * HOUR);
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ openMs: base + i * HOUR, open: 10 + i, high: 10 + i + 1, low: 10 + i - 1, close: 10 + i + 0.5 });
  const h4 = aggregateEat(rows, 'H4');
  assert.equal(h4.length, 2);
  assert.equal(h4[0].openMs, base);
  assert.equal(h4[0].closeMs, base + 4 * HOUR);
  assert.equal(h4[0].open, 10);               // first open
  assert.equal(h4[0].close, 13.5);            // 4th candle close (10+3+0.5)
});

test('gaps produce no fabricated candle (a missing span simply has no bucket)', () => {
  // day A has data, then a 2-day gap, then day D — only two D1 candles exist
  const rows = [h1(0, 10, 11, 9, 10.5), h1(1, 10.5, 11.2, 10, 11), h1(72, 11, 12, 10.5, 11.5)];
  const d1 = aggregateEat(rows, 'D1');
  assert.equal(d1.length, 2);
  assert.equal(d1[0].openMs, T);
  assert.equal(d1[1].openMs, T + 3 * DAY);
});
