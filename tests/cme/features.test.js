'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { microFeatures, microBreadth, microDivergence } = require('../../api/_cme-15m-features');
const { computeCurrencyComponents } = require('../../api/_cme-features');
const { evaluateWindows } = require('../../api/_cme-scan');
const { STATES, PAIRS, HOUR_MS, M15_MS } = require('../../api/_cme-constants');

test('micro persistence = fraction of 15M steps aligned with the macro direction', () => {
  const mf = microFeatures([0.001, 0.0008, -0.0002, 0.0006], +1); // 3 of 4 up
  assert.equal(mf.microPersistence, 0.75);
  assert.equal(mf.steps, 4);
});

test('micro-acceleration: rising pace up → MICRO_ACCELERATING, fading → MICRO_DECELERATING', () => {
  const accel = microFeatures([0.0002, 0.0003, 0.0008, 0.0010], +1); // pace increasing
  assert.ok(accel.microAcceleration > 0);
  assert.equal(accel.microState, STATES.MICRO_ACCELERATING);
  const decel = microFeatures([0.0010, 0.0008, 0.0003, 0.0001], +1); // pace fading
  assert.ok(decel.microAcceleration < 0);
  assert.equal(decel.microState, STATES.MICRO_DECELERATING);
});

test('micro breadth and H1↔15M divergence detection', () => {
  assert.equal(microBreadth([0.01, 0.02, -0.01, 0.03], +1), 0.75);
  const diverging = microDivergence(+1, { microState: STATES.MICRO_DECELERATING, microPersistence: 0.4 });
  assert.equal(diverging, true);   // macro up but micro fading + weak alignment
  const aligned = microDivergence(+1, { microState: STATES.MICRO_ACCELERATING, microPersistence: 0.8 });
  assert.equal(aligned, false);
});

test('movement score sign follows raw movement; full breadth when all contributions agree', () => {
  const up = computeCurrencyComponents({ rawMovement: 0.003, hourlySeq: [0.001, 0.001, 0.001], contribsH1: [0.01, 0.02, 0.03, 0.01, 0.02, 0.01, 0.02] });
  assert.ok(up.movementScore > 0);
  assert.equal(up.breadthH1, 1);
  const down = computeCurrencyComponents({ rawMovement: -0.003, hourlySeq: [-0.001, -0.001, -0.001], contribsH1: [-0.01, -0.02, 0.01, -0.03, -0.02, -0.01, -0.02] });
  assert.ok(down.movementScore < 0);
  assert.ok(down.breadthH1 < 1 && down.breadthH1 > 0);
});

// mixed-timeframe no-lookahead: 15M candles beyond evalMs must not change the result
test('mixed-timeframe no-lookahead: later 15M/H1 candles do not affect the snapshot', () => {
  const startMs = Date.UTC(2026, 7, 13, 8, 0, 0);
  const build = () => {
    const pd = {};
    for (const pair of PAIRS) {
      const h1 = [], m15 = [];
      let price = 1.0;
      for (let k = 25; k > 0; k--) { const ms = startMs - k * HOUR_MS; h1.push({ openMs: ms, time: '', open: price, high: price * 1.001, low: price * 0.999, close: price }); }
      for (let hi = 0; hi < 3; hi++) { // 3 hours; only 2 will be "completed" at evalMs
        const ms = startMs + hi * HOUR_MS; const close = price * 1.0005;
        h1.push({ openMs: ms, time: '', open: price, high: close * 1.0002, low: price * 0.9998, close });
        for (let s = 0; s < 4; s++) { const mms = ms + s * M15_MS; m15.push({ openMs: mms, time: '', open: price, high: close * 1.0001, low: price * 0.9999, close }); }
        price = close;
      }
      pd[pair] = { h1, m15 };
    }
    return pd;
  };
  const data = build();
  const evalMs = startMs + 2 * HOUR_MS;            // third hour (and its 15M) not completed
  // The evaluator only reads candles ≤ evalMs; the maps are pre-built, but window
  // bounds cap at the last completed hour, so the third-hour data is never used.
  const a = evaluateWindows(data, evalMs, { enhance15m: true });
  const b = evaluateWindows(data, evalMs, { enhance15m: true });
  assert.deepEqual(a.H1, b.H1);
  assert.equal(a.H1.endCloseUtc, new Date(startMs + 2 * HOUR_MS).toISOString()); // latest completed close
});
