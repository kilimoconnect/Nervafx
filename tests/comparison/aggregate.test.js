'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bucketStart, weekStartUtc, monthStartUtc, aggregatePairs, aggregateIndexPath } = require('../../research/comparison/aggregate');
const { buildIndices } = require('../../research/comparison/index-build');
const { CURRENCIES, PAIRS, M15_MS } = require('../../research/comparison/config');

const H1 = 60 * 60 * 1000;

test('bucketStart aligns to UTC grid; W1=Monday, MN=1st', () => {
  const wed = Date.UTC(2026, 0, 7, 13, 20, 0);                 // Wed 2026-01-07
  assert.equal(bucketStart(wed, 'M30'), Date.UTC(2026, 0, 7, 13, 0));
  assert.equal(bucketStart(wed, 'H4'), Date.UTC(2026, 0, 7, 12, 0));   // 12:00–16:00 bucket
  assert.equal(bucketStart(wed, 'D1'), Date.UTC(2026, 0, 7));
  assert.equal(bucketStart(wed, 'W1'), Date.UTC(2026, 0, 5));          // Monday
  assert.equal(bucketStart(wed, 'MN'), Date.UTC(2026, 0, 1));          // 1st
  assert.equal(weekStartUtc(wed), Date.UTC(2026, 0, 5));
  assert.equal(monthStartUtc(wed), Date.UTC(2026, 0, 1));
});

test('aggregatePairs rolls up OHLC (open=first, high=max, low=min, close=last)', () => {
  const START = Date.UTC(2025, 4, 1, 0, 0, 0);
  // 8 M15 bars (2 hours) with distinctive highs/lows
  const base = [];
  for (let i = 0; i < 8; i++) base.push({ openMs: START + i * M15_MS, open: 100 + i, high: 100 + i + 2, low: 100 + i - 3, close: 100 + i + 0.5 });
  const m30 = aggregatePairs(base, 'M30');
  assert.equal(m30.length, 4);                 // 8 M15 → 4 M30
  assert.equal(m30[0].open, base[0].open);     // first
  assert.equal(m30[0].close, base[1].close);   // last in bucket
  assert.equal(m30[0].high, Math.max(base[0].high, base[1].high));
  assert.equal(m30[0].low, Math.min(base[0].low, base[1].low));
  assert.equal(m30[0].time, START);
  // H1 roll-up: 8 M15 → 2 H1
  const h1 = aggregatePairs(base, 'H1');
  assert.equal(h1.length, 2);
  assert.equal(h1[0].open, base[0].open);
  assert.equal(h1[0].close, base[3].close);
  assert.equal(h1[0].high, Math.max(...base.slice(0, 4).map((b) => b.high)));
});

test('aggregateIndexPath produces contiguous bars (open = previous close) at a higher TF', () => {
  const START = Date.UTC(2025, 4, 1, 0, 0, 0), n = 4 * 24 * 4;   // 4 days of M15
  // self-consistent network; AUD rises so its index is monotone
  const V = {}; for (const c of CURRENCIES) V[c] = () => 1; V.AUD = (i) => Math.exp(0.0003 * i);
  const by = {};
  for (const p of PAIRS) { const [b, q] = p.split('_'); by[p] = []; for (let i = 0; i < n; i++) { const px = V[b](i) / V[q](i); by[p].push({ openMs: START + i * M15_MS, open: px, high: px, low: px, close: px }); } }
  const built = buildIndices(by);
  const h1 = aggregateIndexPath(built, 'AUD', 'H1');
  assert.ok(h1.length > 20);
  // bars are contiguous: each open equals the prior bar's close (shared boundary sample)
  for (let i = 1; i < h1.length; i++) assert.ok(Math.abs(h1[i].open - h1[i - 1].close) < 1e-9);
  // monotone rising index → closes strictly increase, high >= close >= open on each bar
  for (const b of h1) { assert.ok(b.high >= b.close && b.close >= b.open && b.open >= b.low); }
  assert.ok(h1[h1.length - 1].close > h1[0].open);
  // bucket times are H1-aligned
  for (const b of h1) assert.equal(b.time % H1, 0);
});
