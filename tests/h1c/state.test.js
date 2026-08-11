'use strict';

// NervaFX H1 Continuation Engine — state machine tests.
// Run with:  node --test tests/h1c

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSetup } = require('../../api/_h1c-state');
const { STATES, INVALIDATION } = require('../../api/_h1c-constants');

const START = Date.UTC(2026, 0, 1);
const HOUR = 3600000;
function mk(rows) {
  return rows.map((r, i) => ({
    time: new Date(START + i * HOUR).toISOString(), ms: START + i * HOUR,
    open: r[0], high: r[1], low: r[2], close: r[3],
  }));
}
function refBUY(over = {}) {
  return Object.assign({
    direction: 1, endIdx: 2, endPrice: 1.0030, high: 1.0030, low: 1.0000,
    netMove: 0.0030, candleCount: 3, atr: 0.0010, quality: 90,
    startIdx: 0, endTime: new Date(START + 2 * HOUR).toISOString(),
  }, over);
}

// impulse (0–2), then a six-candle pullback that stalls at the low (A=7, B=8).
const BASE = [
  [1.0000, 1.0010, 1.0000, 1.0010], [1.0010, 1.0020, 1.0010, 1.0020], [1.0020, 1.0030, 1.0020, 1.0030],
  [1.0030, 1.0030, 1.0024, 1.0025], [1.0025, 1.0025, 1.0019, 1.0020], [1.0020, 1.0020, 1.0014, 1.0015],
  [1.0015, 1.0015, 1.0011, 1.0012], [1.0012, 1.0013, 1.0010, 1.0011], [1.0011, 1.0013, 1.0010, 1.0012],
];

test('READY transition on a valid stall failure', () => {
  const r = evaluateSetup(mk(BASE), { reference: refBUY() });
  assert.equal(r.state, STATES.CONTINUATION_READY);
  assert.ok(typeof r.setupScore === 'number');
  assert.ok(['A-GRADE', 'VALID', 'WATCH', 'LOW_QUALITY'].includes(r.grade));
  assert.equal(r.failure.type, 'BUY_STALL');
});

test('SECOND_PUSH_STARTED on a close beyond the failure box', () => {
  const rows = [...BASE, [1.0012, 1.0016, 1.0012, 1.0015]];   // closes above box high + buffer
  const r = evaluateSetup(mk(rows), { reference: refBUY() });
  assert.equal(r.state, STATES.SECOND_PUSH_STARTED);
});

test('CONTINUATION_CONFIRMED on a close beyond the reference high', () => {
  const rows = [...BASE, [1.0012, 1.0016, 1.0012, 1.0015], [1.0015, 1.0032, 1.0015, 1.0031]];
  const r = evaluateSetup(mk(rows), { reference: refBUY() });
  assert.equal(r.state, STATES.CONTINUATION_CONFIRMED);
});

test('structural invalidation on a close below the reference low', () => {
  const rows = [...BASE, [1.0011, 1.0011, 0.9990, 0.9995]];
  const r = evaluateSetup(mk(rows), { reference: refBUY() });
  assert.equal(r.state, STATES.INVALIDATED);
  assert.equal(r.invalidation, INVALIDATION.STRUCTURE_BREAK);
});

test('READY expires after three inactive candles', () => {
  const flat = [1.0012, 1.0013, 1.0010, 1.0012];
  const rows = [...BASE, flat.slice(), flat.slice(), flat.slice(), flat.slice()];   // +4 with no progression
  const r = evaluateSetup(mk(rows), { reference: refBUY() });
  assert.equal(r.state, STATES.EXPIRED);
});

test('a forming H1 candle cannot advance the state', () => {
  const rows = [...BASE, [1.0012, 1.0016, 1.0012, 1.0015], [1.0015, 1.0032, 1.0015, 1.0031]];
  const candles = mk(rows);
  // Excluding the last (forming) candle, it is only SECOND_PUSH — not CONFIRMED.
  const excl = evaluateSetup(candles, { reference: refBUY(), searchEndIdx: candles.length - 2 });
  assert.equal(excl.state, STATES.SECOND_PUSH_STARTED);
  // Including it (completed) confirms.
  const incl = evaluateSetup(candles, { reference: refBUY() });
  assert.equal(incl.state, STATES.CONTINUATION_CONFIRMED);
});
