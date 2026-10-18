'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeMetrics } = require('../../research/paw1h4/metrics');
const { buildFrame } = require('../../research/paw1h4/frame');
const { CONFIG, H1_MS } = require('../../research/paw1h4/config');

test('metrics: expectancy, profit factor, drawdown, streak, overlap, rejections', () => {
  const D = 24 * 3600000;
  const trades = [
    { accepted: true, R: 1, barsHeld: 3, pair: 'A', signalCloseMs: D, entryOpenMs: 1, exit: { ms: 5 } },
    { accepted: true, R: -1, barsHeld: 2, pair: 'A', signalCloseMs: 2 * D, entryOpenMs: 6, exit: { ms: 9 } },
    { accepted: true, R: 2, barsHeld: 4, pair: 'B', signalCloseMs: 3 * D, entryOpenMs: 10, exit: { ms: 14 } },
    { accepted: false, rejectReason: 'no_target' },
  ];
  const m = computeMetrics(trades);
  assert.equal(m.accepted, 3);
  assert.equal(m.rejected, 1);
  assert.deepEqual(m.rejectByReason, { no_target: 1 });
  assert.equal(m.expectancyR, 0.6667);
  assert.equal(m.totalR, 2);
  assert.equal(m.profitFactor, 3);
  assert.equal(m.maxDrawdownR, 1);
  assert.equal(m.maxLosingStreak, 1);
  assert.equal(m.avgHoldBars, 3);
  assert.equal(m.maxConcurrentExposure, 1);
});

test('metrics: overlapping exposure counts concurrent open trades', () => {
  const trades = [
    { accepted: true, R: 1, barsHeld: 1, pair: 'A', signalCloseMs: 1, entryOpenMs: 0, exit: { ms: 10 } },
    { accepted: true, R: 1, barsHeld: 1, pair: 'B', signalCloseMs: 2, entryOpenMs: 5, exit: { ms: 15 } },  // overlaps the first
  ];
  assert.equal(computeMetrics(trades).maxConcurrentExposure, 2);
});

// Deterministic H1 generator: a gentle uptrend with weekly/H4 structure.
function genH1(startMs, n) {
  const out = [];
  let p = 1.1000;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 37) * 0.0006 + 0.00004;         // trend + waves → produces swings
    const o = p, c = p + Math.sin(i / 5) * 0.0003;
    out.push({ openMs: startMs + i * H1_MS, closeMs: startMs + (i + 1) * H1_MS, open: o, high: Math.max(o, c) + 0.0002, low: Math.min(o, c) - 0.0002, close: c });
  }
  return out;
}

test('frame is causal: all returned candles/pivots are knowable as-of t', () => {
  const start = Date.UTC(2026, 0, 5, 0, 0, 0);
  const h1 = genH1(start, 2000);
  const asOf = start + 1500 * H1_MS;
  const f = buildFrame(h1, 'EUR_USD', asOf, CONFIG);
  assert.equal(f.pair, 'EUR_USD');
  assert.ok(['UNAVAILABLE', 'NEUTRAL', 'BULLISH', 'BEARISH'].includes(f.weekly.bias));
  assert.ok(f.dataQuality.h4Count > 0);
  for (const c of f.h4candles) assert.ok(c.t < asOf, 'no H4 candle opens at/after asOf');
  for (const p of f.h4pivots) assert.ok(p.confirmedMs <= asOf, 'no pivot confirmed after asOf');
  // appending future H1 must not change the as-of frame
  const h1ext = h1.concat(genH1(start + 2000 * H1_MS, 200));
  const f2 = buildFrame(h1ext, 'EUR_USD', asOf, CONFIG);
  assert.equal(JSON.stringify(f.h4), JSON.stringify(f2.h4));
  assert.equal(JSON.stringify(f.weekly.bias), JSON.stringify(f2.weekly.bias));
});
