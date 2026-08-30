'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateWindows } = require('../../api/_cme15-scan');
const { PAIRS, M15_MS, M5_MS, BOS, WINDOWS } = require('../../api/_cme15-constants');

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0); // 15m-aligned
const lastM15Open = Math.floor(NOW / M15_MS) * M15_MS - M15_MS;
const lastM5Open = Math.floor(NOW / M5_MS) * M5_MS - M5_MS;

function series(pair, stepMs, n, endOpen, breakout) {
  const arr = [];
  const base = 1.10 + (pair.charCodeAt(0) % 7) * 0.01;
  for (let i = n - 1; i >= 0; i--) {
    const openMs = endOpen - i * stepMs;
    const drift = (n - i) * 0.00002 * ((pair.charCodeAt(4) % 2) ? 1 : -1);
    const o = base + drift, c = o + 0.0003 * ((i % 3) - 1);
    arr.push({ openMs, time: new Date(openMs).toISOString(), open: o, high: Math.max(o, c) + 0.0004, low: Math.min(o, c) - 0.0004, close: c });
  }
  if (breakout) { const m = arr.length, K = 12; let lvl = arr[m - K - 1].high; for (let j = m - K; j < m; j++) { lvl += 0.0025; arr[j].open = arr[j - 1].close; arr[j].close = lvl; arr[j].high = lvl + 0.0002; arr[j].low = arr[j].open - 0.0002; } }
  return arr;
}
function build(breakout) {
  const pd = {};
  for (const p of PAIRS) pd[p] = { m15: series(p, M15_MS, 300, lastM15Open, breakout), m5: series(p, M5_MS, 400, lastM5Open, breakout) };
  return pd;
}

test('twin uses the M15/M5 window set', () => {
  assert.deepEqual(WINDOWS.slice(0, 2), ['M15', 'M5']);
  assert.equal(BOS.STRUCTURE_LOOKBACK, 20);
});

test('all six windows evaluate and produce 28 currency-complete edges', () => {
  const ev = evaluateWindows(build(true), NOW, { enhanceMicro: true });
  for (const w of WINDOWS) assert.equal(ev.windows[w].status, 'OK', w + ' should be OK');
  assert.equal(Object.keys(ev.windows.M15.currencies).length, 8);
  assert.equal(ev.pairEdges.length, PAIRS.length);
  assert.equal(ev.configurationVersion, 'structure_15m_v1');
});

test('BOS references the previous 20 M15 candles', () => {
  const ev = evaluateWindows(build(true), NOW, { enhanceMicro: true });
  const withBreak = ev.pairEdges.find((e) => e.bosDirection === 'BULLISH');
  assert.ok(withBreak, 'expected at least one bullish break');
  assert.equal(withBreak.h1BreakOfStructure.lookback, 20);
  assert.equal(withBreak.opportunity, 'STRUCTURE_CONFIRMED_MOVEMENT');
});

test('no synthetic breakout → no structure-confirmed movement', () => {
  const ev = evaluateWindows(build(false), NOW, { enhanceMicro: true });
  const confirmed = ev.pairEdges.filter((e) => e.opportunity === 'STRUCTURE_CONFIRMED_MOVEMENT');
  assert.equal(confirmed.length, 0);
});

test('micro layer degrades gracefully when M5 is absent', () => {
  const pd = build(true);
  for (const p of PAIRS) pd[p].m5 = [];
  const ev = evaluateWindows(pd, NOW, { enhanceMicro: true });
  assert.equal(ev.windows.M15.status, 'OK');   // still evaluates on M15 alone
  assert.equal(ev.windows.M5.status, 'NOT_ACTIVE');
});
