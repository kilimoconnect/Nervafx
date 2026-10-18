'use strict';

const test = require('node:test');
const assert = require('node:assert');
const agg = require('../../research/paw1h4/aggregate');
const { runEngine } = require('../../research/paw1h4/engine');
const { frame, runStrat, CONFIG } = require('../../research/pad1h1');
const { H1_MS, DAY_MS } = require('../../research/paw1h4/config');

const START = Date.UTC(2026, 0, 5, 0, 0, 0);   // Mon 00:00 UTC
function h1series(startMs, n, base) {
  const out = [];
  for (let i = 0; i < n; i++) { const o = base + i; out.push({ openMs: startMs + i * H1_MS, closeMs: startMs + (i + 1) * H1_MS, open: o, high: o + 0.5, low: o - 0.5, close: o + 0.1 }); }
  return out;
}

test('D1 aggregation: UTC-day buckets, completed-only, partial flagged', () => {
  const h1 = h1series(START, 48, 100);                 // 2 full UTC days
  const bars = agg.d1(h1, START + 48 * H1_MS);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].openMs, agg.dayStart(START));
  assert.equal(bars[0].h1Count, 24);
  assert.equal(bars[0].partial, false);
  assert.equal(bars[0].high, Math.max.apply(null, h1.slice(0, 24).map((c) => c.high)));
  // one ms before day-2 closes → only day 1 is complete
  assert.equal(agg.d1(h1, bars[1].closeMs - 1).length, 1);
  // a short day is partial, high/low still real
  const partial = agg.d1(h1series(START, 5, 50), START + 24 * H1_MS);
  assert.equal(partial[0].partial, true);
  assert.equal(partial[0].h1Count, 5);
});

test('h1AsOf returns only completed H1 (closeMs ≤ t), as entry candles', () => {
  const h1 = h1series(START, 10, 1);
  const got = agg.h1AsOf(h1, START + 5 * H1_MS);
  assert.equal(got.length, 5);
  assert.ok(got.every((c) => c.closeMs <= START + 5 * H1_MS));
});

// The engine is timeframe-agnostic: the same clean bullish continuation scenario,
// stamped at H1 intervals, emits a BUY (proving the D1→H1 entry wiring).
function bars(rows) {
  return rows.map((r, i) => { const openMs = START + i * H1_MS; const high = r[0], low = r[1], close = r[2] != null ? r[2] : (high + low) / 2; return { openMs, closeMs: openMs + H1_MS, open: (high + low) / 2, high, low, close }; });
}
const BUY_ROWS = [
  [10.0, 9.0], [10.2, 9.2], [12.0, 9.5], [10.5, 9.0], [10.0, 7.0],
  [10.3, 8.5], [11.0, 8.0], [9.8, 7.5], [9.5, 6.0], [10.0, 6.5],
  [12.5, 7.0, 12.0], [11.5, 9.0], [13.0, 9.5], [12.0, 9.0], [12.2, 8.5],
  [12.5, 9.2], [12.8, 9.4], [13.5, 10.0, 13.3], [13.6, 10.5],
];
const bullCtx = { biasAt: () => ({ bias: 'BULLISH', eligibilityStartMs: START - 1, invalidationLevel: 1 }), levelsAsOf: () => ({ highs: [], lows: [] }) };

test('D1→H1 uses the shared engine: a bullish H1 continuation emits one BUY', () => {
  const { opportunities } = runEngine(bars(BUY_ROWS), bullCtx, Object.assign({}, CONFIG, { pair: 'EUR_USD' }));
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].dir, 'BUY');
  assert.equal(opportunities[0].trigger, 13.0);
  assert.equal(opportunities[0].stopRef, 8.5);
});

function genH1(startMs, n) {
  const out = []; let p = 1.1000;
  for (let i = 0; i < n; i++) { p += Math.sin(i / 23) * 0.0005 + 0.00003; const o = p, c = p + Math.sin(i / 4) * 0.0003; out.push({ openMs: startMs + i * H1_MS, closeMs: startMs + (i + 1) * H1_MS, open: o, high: Math.max(o, c) + 0.0002, low: Math.min(o, c) - 0.0002, close: c }); }
  return out;
}

test('D1→H1 frame is causal and timeframe-labelled', () => {
  const h1 = genH1(START, 1500);
  const asOf = START + 1200 * H1_MS;
  const f = frame(h1, 'EUR_USD', asOf);
  assert.equal(f.strategyId, 'PA_D1_H1_CONTINUATION');
  assert.equal(f.trendLabel, 'D1');
  assert.equal(f.entryLabel, 'H1');
  assert.ok(['UNAVAILABLE', 'NEUTRAL', 'BULLISH', 'BEARISH'].includes(f.weekly.bias));
  for (const c of f.h4candles) assert.ok(c.t < asOf);
  for (const p of f.h4pivots) assert.ok(p.confirmedMs <= asOf);
  // appending future H1 must not change the as-of frame
  const f2 = frame(h1.concat(genH1(START + 1500 * H1_MS, 100)), 'EUR_USD', asOf);
  assert.equal(JSON.stringify(f.h4), JSON.stringify(f2.h4));
});
