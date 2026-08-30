'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateWindows } = require('../../api/_cme-scan');
const { PAIRS } = require('../../api/_cme-constants');

const HOUR = 3600000, M15 = 900000;
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const lastH1 = Math.floor(NOW / HOUR) * HOUR - HOUR;
const lastM15 = Math.floor(NOW / M15) * M15 - M15;

function h1s(pair, n, brk) {
  const arr = []; const base = 1.10 + (pair.charCodeAt(0) % 7) * 0.01;
  for (let i = n - 1; i >= 0; i--) {
    const openMs = lastH1 - i * HOUR; const drift = (n - i) * 0.00003 * ((pair.charCodeAt(4) % 2) ? 1 : -1);
    let o = base + drift, c = o + 0.0005 * ((i % 3) - 1), hi = Math.max(o, c) + 0.0006, lo = Math.min(o, c) - 0.0006;
    if (brk && i === 0) { c = hi + 0.004; hi = c + 0.0003; }
    arr.push({ openMs, time: new Date(openMs).toISOString(), open: o, high: hi, low: lo, close: c });
  }
  return arr;
}
function m15s(pair, n) {
  const arr = []; const base = 1.10 + (pair.charCodeAt(0) % 7) * 0.01;
  for (let i = n - 1; i >= 0; i--) { const openMs = lastM15 - i * M15; const o = base, c = o + 0.0002 * ((i % 3) - 1); arr.push({ openMs, time: new Date(openMs).toISOString(), open: o, high: Math.max(o, c) + 0.0003, low: Math.min(o, c) - 0.0003, close: c }); }
  return arr;
}
function build(brk) { const pd = {}; for (const p of PAIRS) pd[p] = { h1: h1s(p, 120, brk), m15: m15s(p, 200) }; return pd; }

test('primaryOnly computes only the H1 window and identical pair edges (H1 BOS lookback 5)', () => {
  const pd = build(true);
  const full = evaluateWindows(pd, NOW, { enhance15m: true });
  const prim = evaluateWindows(pd, NOW, { enhance15m: true, primaryOnly: true });
  assert.deepEqual(Object.keys(prim.windows), ['H1']);
  assert.equal(prim.pairEdges.length, PAIRS.length);
  assert.deepEqual(prim.pairEdges.map((e) => e.pair + e.opportunity), full.pairEdges.map((e) => e.pair + e.opportunity));
  const bull = prim.pairEdges.find((e) => e.bosDirection === 'BULLISH');
  assert.ok(bull && bull.h1BreakOfStructure.lookback === 5);
});
