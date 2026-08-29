'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateWindows } = require('../../api/_cme05-scan');
const { PAIRS, BASE_MS, BOS, WINDOWS } = require('../../api/_cme05-constants');

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const lastOpen = Math.floor(NOW / BASE_MS) * BASE_MS - BASE_MS;

function m5series(pair, n, breakout) {
  const arr = [];
  const base = 1.10 + (pair.charCodeAt(0) % 7) * 0.01;
  for (let i = n - 1; i >= 0; i--) {
    const openMs = lastOpen - i * BASE_MS;
    const drift = (n - i) * 0.000006 * ((pair.charCodeAt(4) % 2) ? 1 : -1);
    const o = base + drift, c = o + 0.0002 * ((i % 3) - 1);
    arr.push({ openMs, time: new Date(openMs).toISOString(), open: o, high: Math.max(o, c) + 0.0003, low: Math.min(o, c) - 0.0003, close: c });
  }
  if (breakout) { const last = arr[arr.length - 1]; last.close = last.high + 0.0025; last.high = last.close + 0.0002; }
  return arr;
}
function build(breakout) {
  const pd = {};
  for (const p of PAIRS) pd[p] = { m5: m5series(p, 700, breakout) };
  return pd;
}

test('5M constants: M5 primary, no micro window, BOS lookback 60', () => {
  assert.equal(WINDOWS[0], 'M5');
  assert.equal(WINDOWS.indexOf('M15'), -1);
  assert.equal(BOS.STRUCTURE_LOOKBACK, 60);
  assert.equal(BASE_MS, 300000);
});

test('all windows evaluate; 28 edges; BOS lookback 60; structure-confirmed on breakout', () => {
  const ev = evaluateWindows(build(true), NOW);
  for (const w of WINDOWS) assert.equal(ev.windows[w].status, 'OK', w);
  assert.equal(ev.pairEdges.length, PAIRS.length);
  assert.equal(ev.configurationVersion, 'structure_5m_v1');
  const bull = ev.pairEdges.find((e) => e.bosDirection === 'BULLISH');
  assert.ok(bull && bull.h1BreakOfStructure.lookback === 60);
  assert.equal(bull.opportunity, 'STRUCTURE_CONFIRMED_MOVEMENT');
});

test('no micro layer on currency components', () => {
  const ev = evaluateWindows(build(true), NOW);
  assert.equal(ev.windows.M5.currencies.USD.microStructure, undefined);
});

test('no breakout → no structure-confirmed movement', () => {
  const ev = evaluateWindows(build(false), NOW);
  assert.equal(ev.pairEdges.filter((e) => e.opportunity === 'STRUCTURE_CONFIRMED_MOVEMENT').length, 0);
});
