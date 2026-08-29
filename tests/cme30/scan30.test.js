'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateWindows } = require('../../api/_cme30-scan');
const { synthM30 } = require('../../api/_cme30-data');
const { PAIRS, BASE_MS, MICRO_MS, BOS, WINDOWS } = require('../../api/_cme30-constants');

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const lastM15Open = Math.floor(NOW / MICRO_MS) * MICRO_MS - MICRO_MS;

function m15series(pair, n, breakout) {
  const arr = [];
  const base = 1.10 + (pair.charCodeAt(0) % 7) * 0.01;
  for (let i = n - 1; i >= 0; i--) {
    const openMs = lastM15Open - i * MICRO_MS;
    const drift = (n - i) * 0.00001 * ((pair.charCodeAt(4) % 2) ? 1 : -1);
    const o = base + drift, c = o + 0.0003 * ((i % 3) - 1);
    arr.push({ openMs, time: new Date(openMs).toISOString(), open: o, high: Math.max(o, c) + 0.0004, low: Math.min(o, c) - 0.0004, close: c });
  }
  if (breakout) { const last = arr[arr.length - 1]; last.close = last.high + 0.0030; last.high = last.close + 0.0002; }
  return arr;
}
function build(breakout) {
  const pd = {};
  for (const p of PAIRS) { const m15 = m15series(p, 600, breakout); pd[p] = { m15, m30: synthM30(m15, NOW) }; }
  return pd;
}

test('30M constants: M30/M15 windows, BOS lookback 10', () => {
  assert.deepEqual(WINDOWS.slice(0, 2), ['M30', 'M15']);
  assert.equal(BOS.STRUCTURE_LOOKBACK, 10);
  assert.equal(BASE_MS, 1800000);
});

test('synthM30 buckets two M15 into one M30', () => {
  const m15 = m15series('EUR_USD', 20, false);
  const m30 = synthM30(m15, NOW);
  assert.ok(m30.length >= 9 && m30.length <= 10);
  assert.equal(m30[0].openMs % BASE_MS, 0);
});

test('all windows evaluate; 28 edges; BOS lookback 10; structure-confirmed on breakout', () => {
  const ev = evaluateWindows(build(true), NOW, { enhanceMicro: true });
  for (const w of WINDOWS) assert.equal(ev.windows[w].status, 'OK', w);
  assert.equal(ev.pairEdges.length, PAIRS.length);
  assert.equal(ev.configurationVersion, 'structure_30m_v1');
  const bull = ev.pairEdges.find((e) => e.bosDirection === 'BULLISH');
  assert.ok(bull && bull.h1BreakOfStructure.lookback === 10);
  assert.equal(bull.opportunity, 'STRUCTURE_CONFIRMED_MOVEMENT');
});

test('no breakout → no structure-confirmed movement', () => {
  const ev = evaluateWindows(build(false), NOW, { enhanceMicro: true });
  assert.equal(ev.pairEdges.filter((e) => e.opportunity === 'STRUCTURE_CONFIRMED_MOVEMENT').length, 0);
});
