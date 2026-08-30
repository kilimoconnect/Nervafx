'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateWindows } = require('../../api/_cmeh4-scan');
const { synthH4 } = require('../../api/_cmeh4-data');
const { PAIRS, BASE_MS, MICRO_MS, BOS, WINDOWS } = require('../../api/_cmeh4-constants');

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const lastH1Open = Math.floor(NOW / MICRO_MS) * MICRO_MS - MICRO_MS;

function h1series(pair, n, breakout) {
  const arr = [];
  const base = 1.10 + (pair.charCodeAt(0) % 7) * 0.01;
  for (let i = n - 1; i >= 0; i--) {
    const openMs = lastH1Open - i * MICRO_MS;
    const drift = (n - i) * 0.00003 * ((pair.charCodeAt(4) % 2) ? 1 : -1);
    const o = base + drift, c = o + 0.0006 * ((i % 3) - 1);
    arr.push({ openMs, time: new Date(openMs).toISOString(), open: o, high: Math.max(o, c) + 0.0008, low: Math.min(o, c) - 0.0008, close: c });
  }
  if (breakout) { for (let k = 1; k <= 4; k++) { const last = arr[arr.length - k]; last.close = last.high + 0.006; last.high = last.close + 0.0004; } }
  return arr;
}
function build(breakout) {
  const pd = {};
  for (const p of PAIRS) { const h1 = h1series(p, 400, breakout); pd[p] = { h1, h4: synthH4(h1, NOW) }; }
  return pd;
}

test('H4 constants: H4/H1 windows, BOS lookback 5, 4h base', () => {
  assert.deepEqual(WINDOWS.slice(0, 2), ['H4', 'H1']);
  assert.equal(BOS.STRUCTURE_LOOKBACK, 5);
  assert.equal(BASE_MS, 14400000);
});

test('synthH4 buckets four H1 into one H4', () => {
  const h1 = h1series('EUR_USD', 40, false);
  const h4 = synthH4(h1, NOW);
  assert.ok(h4.length >= 9 && h4.length <= 10);
  assert.equal(h4[0].openMs % BASE_MS, 0);
});

test('all windows evaluate; 28 edges; BOS lookback 5; structure-confirmed on breakout', () => {
  const ev = evaluateWindows(build(true), NOW, { enhanceMicro: true });
  for (const w of WINDOWS) assert.equal(ev.windows[w].status, 'OK', w);
  assert.equal(ev.pairEdges.length, PAIRS.length);
  assert.equal(ev.configurationVersion, 'structure_h4_v1');
  const bull = ev.pairEdges.find((e) => e.bosDirection === 'BULLISH');
  assert.ok(bull && bull.h1BreakOfStructure.lookback === 5);
  assert.equal(bull.opportunity, 'STRUCTURE_CONFIRMED_MOVEMENT');
});

test('primaryOnly computes only the H4 window with identical edges', () => {
  const pd = build(true);
  const full = evaluateWindows(pd, NOW, { enhanceMicro: true });
  const prim = evaluateWindows(pd, NOW, { enhanceMicro: true, primaryOnly: true });
  assert.deepEqual(Object.keys(prim.windows), ['H4']);
  assert.deepEqual(prim.pairEdges.map((e) => e.pair + e.opportunity), full.pairEdges.map((e) => e.pair + e.opportunity));
});
