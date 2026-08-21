'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evalH1Window, evaluateWindows } = require('../../api/_cme-scan');
const { CURRENCIES, PAIRS, HOUR_MS, M15_MS } = require('../../api/_cme-constants');

const H = HOUR_MS;
const iso = (ms) => new Date(ms).toISOString();

// Build consistent H1+M15 candles for all 28 pairs from a per-hour currency-movement plan.
function buildPairData(startMs, hourlyMovements) {
  const pairData = {};
  for (const pair of PAIRS) {
    const [b, q] = pair.split('_');
    const h1 = [], m15 = [];
    let price = 1.0;
    for (let k = 25; k > 0; k--) { const ms = startMs - k * H; h1.push({ openMs: ms, time: iso(ms), open: price, high: price * 1.0005, low: price * 0.9995, close: price }); }
    for (let hi = 0; hi < hourlyMovements.length; hi++) {
      const mv = hourlyMovements[hi];
      const r = (mv[b] || 0) - (mv[q] || 0);
      const open = price, close = price * Math.exp(r);
      const ms = startMs + hi * H;
      h1.push({ openMs: ms, time: iso(ms), open, high: Math.max(open, close) * 1.0003, low: Math.min(open, close) * 0.9997, close });
      let mp = open;
      for (let s = 0; s < 4; s++) { const mc = mp * Math.exp(r / 4); const mms = ms + s * M15_MS; m15.push({ openMs: mms, time: iso(mms), open: mp, high: Math.max(mp, mc) * 1.0002, low: Math.min(mp, mc) * 0.9998, close: mc }); mp = mc; }
      price = close;
    }
    pairData[pair] = { h1, m15 };
  }
  return pairData;
}

function zeroSum(mv) { const s = CURRENCIES.reduce((a, c) => a + (mv[c] || 0), 0); const o = {}; CURRENCIES.forEach((c) => { o[c] = (mv[c] || 0) - s / CURRENCIES.length; }); return o; }

test('window decomposition recovers the strongest/weakest currency and signs', () => {
  const startMs = Date.UTC(2026, 7, 13, 8, 0, 0);
  const plan = [
    zeroSum({ USD: 0.001, JPY: -0.002, EUR: 0.0005 }),
    zeroSum({ USD: 0.0015, JPY: -0.0025, GBP: 0.0008 }),
    zeroSum({ USD: 0.0012, JPY: -0.0018, AUD: -0.0004 }),
  ];
  const data = buildPairData(startMs, plan);
  const wb = { startOpenMs: startMs, endOpenMs: startMs + 2 * H };
  const h1map = {}, m15map = {}, atrMap = {};
  for (const p of PAIRS) { h1map[p] = new Map(data[p].h1.map((c) => [c.openMs, c])); m15map[p] = new Map(data[p].m15.map((c) => [c.openMs, c])); atrMap[p] = 0.0005; }
  const w = evalH1Window(wb, h1map, m15map, atrMap, true);

  assert.equal(w.status, 'OK');
  assert.equal(w.pairsUsed, 28);
  assert.ok(w.ssr < 1e-16, 'consistent data → ~zero residual');
  const cur = w.currencies;
  // USD strengthened over the window, JPY weakened
  assert.ok(cur.USD.rawMovement > 0 && cur.USD.movementScore > 0);
  assert.ok(cur.JPY.rawMovement < 0 && cur.JPY.movementScore < 0);
  assert.equal(cur.USD.rank, 1);                 // strongest
  assert.equal(cur.JPY.rank, 8);                 // weakest
  // breadth in [0,1]; USD moved up against all 7 counterparts → breadth 1
  assert.ok(cur.USD.breadthH1 >= 0 && cur.USD.breadthH1 <= 1);
  assert.equal(cur.USD.breadthH1, 1);
  // micro features present
  assert.ok(cur.USD.microState === null || typeof cur.USD.microState === 'string');
});

test('ranks are a permutation of 1..8 and movements sum to zero', () => {
  const startMs = Date.UTC(2026, 7, 13, 8, 0, 0);
  const data = buildPairData(startMs, [zeroSum({ EUR: 0.001, USD: -0.001 })]);
  const wb = { startOpenMs: startMs, endOpenMs: startMs };
  const h1map = {}, m15map = {}, atrMap = {};
  for (const p of PAIRS) { h1map[p] = new Map(data[p].h1.map((c) => [c.openMs, c])); m15map[p] = new Map(data[p].m15.map((c) => [c.openMs, c])); atrMap[p] = 0.0005; }
  const w = evalH1Window(wb, h1map, m15map, atrMap, false);
  const ranks = CURRENCIES.map((c) => w.currencies[c].rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8]);
  const sum = CURRENCIES.reduce((a, c) => a + w.currencies[c].rawMovement, 0);
  assert.ok(Math.abs(sum) < 1e-6);
});

test('evaluateWindows H1 window is deterministic and additive-safe (no future candle used)', () => {
  const startMs = Date.UTC(2026, 7, 13, 8, 0, 0);
  const data = buildPairData(startMs, [zeroSum({ GBP: 0.002, JPY: -0.002 }), zeroSum({ GBP: 0.001, JPY: -0.001 })]);
  const evalMs = startMs + 2 * H; // only the first two hours are completed
  const a = evaluateWindows(data, evalMs, { enhance15m: true });
  const b = evaluateWindows(data, evalMs, { enhance15m: true });
  assert.deepEqual(a.H1, b.H1);
  // H1 window = the latest completed hour (startMs+H). GBP up that hour.
  assert.equal(a.H1.status, 'OK');
  assert.ok(a.H1.currencies.GBP.rawMovement > 0);
});
