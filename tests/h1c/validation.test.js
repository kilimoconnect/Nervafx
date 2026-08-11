'use strict';

// NervaFX H1 Continuation Engine — Portion 8 consolidated validation suite.
// Deterministic synthetic sequences for the 20 required scenarios (several also
// covered in the focused suites; re-verified here end-to-end). Run with:
//   node --test tests/h1c

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSetup } = require('../../api/_h1c-state');
const { detectTwoCandleFailure } = require('../../api/_h1c-failure');
const { analyzePullback } = require('../../api/_h1c-pullback');
const { sanitizeH1 } = require('../../api/_h1c-data');
const { runValidation } = require('../../api/_h1c-validate');
const { STATES, INVALIDATION, OUTCOME, DATA_REJECTIONS, HOUR_MS } = require('../../api/_h1c-constants');

const START = Date.UTC(2026, 0, 1);
const mk = (rows) => rows.map((r, i) => ({ time: new Date(START + i * HOUR_MS).toISOString(), ms: START + i * HOUR_MS, open: r[0], high: r[1], low: r[2], close: r[3] }));
const flats = (n) => Array.from({ length: n }, () => [1.0000, 1.0002, 0.9998, 1.0000]);
const IMP_UP = [[1.0000, 1.0010, 1.0000, 1.0010], [1.0010, 1.0020, 1.0010, 1.0020], [1.0020, 1.0030, 1.0020, 1.0030]];
const refBUY = (o = {}) => Object.assign({ direction: 1, endIdx: 2, endPrice: 1.0030, high: 1.0030, low: 1.0000, netMove: 0.0030, candleCount: 3, atr: 0.0010, quality: 90, endTime: new Date(START + 2 * HOUR_MS).toISOString() }, o);
const refSELL = (o = {}) => Object.assign({ direction: -1, endIdx: 2, endPrice: 0.9970, high: 1.0000, low: 0.9970, netMove: 0.0030, candleCount: 3, atr: 0.0010, quality: 90, endTime: new Date(START + 2 * HOUR_MS).toISOString() }, o);
const slopeDown = (n) => { const r = []; let p = 1.0030; for (let i = 0; i < n; i++) { const c = p - 0.0002; r.push([p, p, c - 0.0001, c]); p = c; } return r; };

// (1) Bullish impulse → 6-candle pullback → stall → second push → confirmation.
test('01 bullish impulse, 6-candle pullback, failure, continuation', () => {
  const rows = [...IMP_UP,
    [1.0030, 1.0030, 1.0024, 1.0025], [1.0025, 1.0025, 1.0019, 1.0020], [1.0020, 1.0020, 1.0014, 1.0015],
    [1.0015, 1.0015, 1.0011, 1.0012], [1.0012, 1.0013, 1.0010, 1.0011], [1.0011, 1.0013, 1.0010, 1.0012],
    [1.0012, 1.0016, 1.0012, 1.0015], [1.0015, 1.0032, 1.0015, 1.0031]];
  const r = evaluateSetup(mk(rows), { reference: refBUY() });
  assert.equal(r.state, STATES.CONTINUATION_CONFIRMED);
  assert.equal(r.pullbackCount, 6);
});

// (2) Bearish impulse → 12-candle pullback → stall → confirmation.
test('02 bearish impulse, 12-candle pullback, failure, continuation', () => {
  const impDown = [[1.0000, 1.0000, 0.9990, 0.9990], [0.9990, 0.9990, 0.9980, 0.9980], [0.9980, 0.9980, 0.9970, 0.9970]];
  const up = [
    [0.9970, 0.9973, 0.9970, 0.9972], [0.9972, 0.9975, 0.9972, 0.9974], [0.9974, 0.9977, 0.9974, 0.9976],
    [0.9976, 0.9979, 0.9976, 0.9978], [0.9978, 0.9981, 0.9978, 0.9980], [0.9980, 0.9983, 0.9980, 0.9982],
    [0.9982, 0.9985, 0.9982, 0.9984], [0.9984, 0.9987, 0.9984, 0.9986], [0.9986, 0.9989, 0.9986, 0.9988],
    [0.9988, 0.9990, 0.9988, 0.9989], [0.9989, 0.9990, 0.9988, 0.9989], [0.9989, 0.9990, 0.9988, 0.9988], // A(13) B(14) stall
    [0.9988, 0.9988, 0.9960, 0.9965]]; // confirm break below 0.9970
  const r = evaluateSetup(mk([...impDown, ...up]), { reference: refSELL() });
  assert.equal(r.state, STATES.CONTINUATION_CONFIRMED);
  assert.equal(r.pullbackCount, 12);
  assert.equal(r.failure.type, 'SELL_STALL');
});

// (3) CAD/CHF-style: Impulse 1 + pause + Impulse 2 → the LATEST is the reference.
test('03 Impulse 2 selected over Impulse 1', () => {
  const rows = [...flats(22),
    [1.0000, 1.0010, 1.0000, 1.0010], [1.0010, 1.0020, 1.0010, 1.0020], [1.0020, 1.0030, 1.0020, 1.0030], // I1
    [1.0030, 1.0032, 1.0028, 1.0030], [1.0030, 1.0032, 1.0028, 1.0030], [1.0030, 1.0032, 1.0028, 1.0030], // pause
    [1.0030, 1.0040, 1.0030, 1.0040], [1.0040, 1.0050, 1.0040, 1.0050], [1.0050, 1.0060, 1.0050, 1.0060], // I2
    [1.0060, 1.0060, 1.0057, 1.0058], [1.0058, 1.0058, 1.0055, 1.0056], [1.0056, 1.0056, 1.0053, 1.0054]]; // pullback
  const r = evaluateSetup(mk(rows));
  assert.ok(r.reference.endIdx >= 28, `Impulse 2 endIdx, got ${r.reference.endIdx}`);
  assert.ok(r.reference.previousAlignedImpulseCount >= 1);
});

// (4) EUR/GBP-style sideways compression pullback.
test('04 sideways compression → PULLBACK_VALID (sideways type)', () => {
  const box = [
    [1.0030, 1.0030, 1.0025, 1.0026], [1.0026, 1.0028, 1.0022, 1.0024], [1.0024, 1.0028, 1.0022, 1.0026],
    [1.0026, 1.0028, 1.0022, 1.0024], [1.0024, 1.0028, 1.0022, 1.0026], [1.0026, 1.0028, 1.0022, 1.0024]];
  const r = evaluateSetup(mk([...IMP_UP, ...box]), { reference: refBUY() });
  assert.ok([STATES.PULLBACK_VALID, STATES.CONTINUATION_READY].includes(r.state));
  assert.equal(r.pullback.type, 'sideways');
});

// (5) USD/CHF-style sloped pullback.
test('05 sloped correction → sloped type', () => {
  const r = evaluateSetup(mk([...IMP_UP, ...slopeDown(6)]), { reference: refBUY() });
  assert.equal(r.pullback.type, 'sloped');
});

// (6) Wick beyond structural level, valid close → not invalidated.
test('06 wick through the reference low with a valid close', () => {
  const pb = [[1.0030, 1.0030, 1.0027, 1.0028], [1.0028, 1.0028, 0.9995, 1.0026], [1.0026, 1.0026, 1.0023, 1.0024],
    [1.0024, 1.0024, 1.0021, 1.0022], [1.0022, 1.0022, 1.0019, 1.0020], [1.0020, 1.0020, 1.0017, 1.0018]];
  const r = evaluateSetup(mk([...IMP_UP, ...pb]), { reference: refBUY() });
  assert.notEqual(r.state, STATES.INVALIDATED);
});

// (7) Closed-candle structural invalidation.
test('07 structural invalidation on a close below the reference low', () => {
  const pb = [[1.0030, 1.0030, 1.0027, 1.0028], [1.0028, 1.0028, 0.9990, 0.9995]];
  const r = evaluateSetup(mk([...IMP_UP, ...pb]), { reference: refBUY() });
  assert.equal(r.state, STATES.INVALIDATED);
  assert.equal(r.invalidation, INVALIDATION.STRUCTURE_BREAK);
});

// (8) Opposite impulse during the pullback (provisional window).
test('08 opposite impulse invalidation', () => {
  const rows = [...flats(23),
    [1.0000, 1.0030, 1.0000, 1.0030], [1.0030, 1.0060, 1.0030, 1.0060],
    [1.0060, 1.0060, 1.0037, 1.0037], [1.0037, 1.0037, 1.0014, 1.0014], [1.0014, 1.0014, 0.9991, 0.9991]];
  const reference = { direction: 1, endIdx: 24, endPrice: 1.0060, high: 1.0060, low: 0.9500, netMove: 0.0060, candleCount: 2, atr: 0.0007, endTime: new Date(START + 24 * HOUR_MS).toISOString() };
  const r = evaluateSetup(mk(rows), { reference });
  assert.equal(r.invalidation, INVALIDATION.OPPOSITE_IMPULSE);
});

// (9) Pullback shorter than six candles.
test('09 pullback < 6 candles stays PULLBACK_FORMING', () => {
  const r = evaluateSetup(mk([...IMP_UP, ...slopeDown(5)]), { reference: refBUY() });
  assert.equal(r.state, STATES.PULLBACK_FORMING);
});

// (10) Pullback longer than twelve candles with no failure → EXPIRED.
test('10 pullback > 12 candles → EXPIRED', () => {
  const r = evaluateSetup(mk([...IMP_UP, ...slopeDown(13)]), { reference: refBUY() });
  assert.equal(r.state, STATES.EXPIRED);
});

// (11) Valid stall failure.
test('11 stall failure', () => {
  const pb = mk([[1.0013, 1.0014, 1.0010, 1.0011], [1.0011, 1.0013, 1.0010, 1.0012]]);
  assert.equal(detectTwoCandleFailure(pb, refBUY(), 0.0010).type, 'BUY_STALL');
});

// (12) Valid sweep-and-reclaim failure.
test('12 sweep-and-reclaim failure', () => {
  const pb = mk([[1.0013, 1.0014, 1.0010, 1.0011], [1.0011, 1.0012, 1.0008, 1.0012]]);
  assert.equal(detectTwoCandleFailure(pb, refBUY(), 0.0010).type, 'BUY_SWEEP');
});

// (13) Excessive sweep rejection.
test('13 excessive penetration rejected', () => {
  const pb = mk([[1.0013, 1.0014, 1.0010, 1.0011], [1.0011, 1.0012, 1.0007, 1.0012]]);
  assert.equal(detectTwoCandleFailure(pb, refBUY(), 0.0010).valid, false);
});

// (14) Early continuation before candle six.
test('14 early continuation before candle six', () => {
  const pb = [[1.0030, 1.0032, 1.0028, 1.0029], [1.0029, 1.0040, 1.0029, 1.0038]];
  const r = evaluateSetup(mk([...IMP_UP, ...pb]), { reference: refBUY() });
  assert.equal(r.outcome, OUTCOME.EARLY_CONTINUATION);
});

// (15) READY setup expiration.
test('15 READY expiration after inactive candles', () => {
  const stall = [[1.0030, 1.0030, 1.0024, 1.0025], [1.0025, 1.0025, 1.0019, 1.0020], [1.0020, 1.0020, 1.0014, 1.0015],
    [1.0015, 1.0015, 1.0011, 1.0012], [1.0012, 1.0013, 1.0010, 1.0011], [1.0011, 1.0013, 1.0010, 1.0012]];
  const flat = [1.0012, 1.0013, 1.0010, 1.0012];
  const r = evaluateSetup(mk([...IMP_UP, ...stall, flat, flat, flat, flat]), { reference: refBUY() });
  assert.equal(r.state, STATES.EXPIRED);
});

// (16) Current incomplete H1 candle must not trigger a false continuation.
test('16 forming candle cannot confirm', () => {
  const rows = mk([...IMP_UP,
    [1.0030, 1.0030, 1.0024, 1.0025], [1.0025, 1.0025, 1.0019, 1.0020], [1.0020, 1.0020, 1.0014, 1.0015],
    [1.0015, 1.0015, 1.0011, 1.0012], [1.0012, 1.0013, 1.0010, 1.0011], [1.0011, 1.0013, 1.0010, 1.0012],
    [1.0012, 1.0016, 1.0012, 1.0015], [1.0015, 1.0032, 1.0015, 1.0031]]);
  const withForming = evaluateSetup(rows, { reference: refBUY(), searchEndIdx: rows.length - 2 });
  assert.notEqual(withForming.state, STATES.CONTINUATION_CONFIRMED);
});

// (17) Missing H1 candle inside the pullback resets the count.
test('17 missing H1 candle handling', () => {
  const cs = [
    ...IMP_UP.map((r, i) => ({ time: new Date(START + i * HOUR_MS).toISOString(), ms: START + i * HOUR_MS, open: r[0], high: r[1], low: r[2], close: r[3] })),
    { time: '', ms: START + 3 * HOUR_MS, open: 1.0030, high: 1.0030, low: 1.0025, close: 1.0026 },
    { time: '', ms: START + 4 * HOUR_MS, open: 1.0026, high: 1.0026, low: 1.0023, close: 1.0024 },
    { time: '', ms: START + 10 * HOUR_MS, open: 1.0024, high: 1.0024, low: 1.0021, close: 1.0022 }, // gap
    { time: '', ms: START + 11 * HOUR_MS, open: 1.0022, high: 1.0022, low: 1.0019, close: 1.0020 },
  ];
  const pb = analyzePullback(cs, { reference: refBUY() });
  assert.ok(pb.gaps >= 1);
});

// (18) Duplicate H1 candle is rejected at the data layer.
test('18 duplicate H1 candle rejected', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ time: new Date(START + i * HOUR_MS).toISOString(), open: 1, high: 2, low: 0, close: 1 });
  rows.push({ ...rows[1] });
  const r = sanitizeH1(rows, START + 100 * HOUR_MS, { minCandles: 1 });
  assert.equal(r.reason, DATA_REJECTIONS.DUPLICATE_CANDLE);
});

// (19) Repeated identical scan produces identical detector output.
test('19 repeated evaluation is deterministic', () => {
  const cs = mk([...IMP_UP, ...slopeDown(6)]);
  const a = evaluateSetup(cs, { reference: refBUY() });
  const b = evaluateSetup(cs, { reference: refBUY() });
  assert.deepEqual({ s: a.state, c: a.pullback.count }, { s: b.state, c: b.pullback.count });
});

// (20) Independent states across pairs via the historical runner.
test('20 independent states across pairs (runValidation)', () => {
  const buy = [...flats(30),
    [1.0000, 1.0010, 1.0000, 1.0010], [1.0010, 1.0020, 1.0010, 1.0020], [1.0020, 1.0030, 1.0020, 1.0030],
    [1.0030, 1.0030, 1.0024, 1.0025], [1.0025, 1.0025, 1.0019, 1.0020], [1.0020, 1.0020, 1.0014, 1.0015],
    [1.0015, 1.0015, 1.0011, 1.0012], [1.0012, 1.0013, 1.0010, 1.0011], [1.0011, 1.0013, 1.0010, 1.0012]];
  const summary = runValidation({ EUR_USD: mk(buy), GBP_USD: mk(flats(40)) }, {});
  assert.ok(summary.impulses >= 1);
  assert.ok(summary.ready >= 1);
  assert.equal(summary.byDirection.BUY >= 1, true);
});
