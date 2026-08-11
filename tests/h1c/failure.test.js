'use strict';

// NervaFX H1 Continuation Engine — two-candle failure detector tests.
// Run with:  node --test tests/h1c

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTwoCandleFailure } = require('../../api/_h1c-failure');

const ATR = 0.0010;
const cnd = (r) => ({ open: r[0], high: r[1], low: r[2], close: r[3] });
const mk = (rows) => rows.map(cnd);
const refBUY = { direction: 1, high: 1.0030, low: 1.0000 };
const refSELL = { direction: -1, high: 1.0000, low: 0.9950 };

test('bullish stall failure', () => {
  const pb = mk([
    [1.0030, 1.0030, 1.0025, 1.0026],
    [1.0026, 1.0026, 1.0020, 1.0021],
    [1.0021, 1.0021, 1.0015, 1.0016],
    [1.0016, 1.0016, 1.0012, 1.0013],
    [1.0013, 1.0014, 1.0010, 1.0011],   // A
    [1.0011, 1.0013, 1.0010, 1.0012],   // B (stall: low holds, closes up)
  ]);
  const f = detectTwoCandleFailure(pb, refBUY, ATR);
  assert.equal(f.valid, true);
  assert.equal(f.type, 'BUY_STALL');
  assert.equal(f.failureBoxLow, 1.0010);
  assert.equal(f.failureBoxHigh, 1.0014);
});

test('bullish sweep-and-reclaim failure', () => {
  const pb = mk([
    [1.0030, 1.0030, 1.0025, 1.0026],
    [1.0026, 1.0026, 1.0020, 1.0021],
    [1.0021, 1.0021, 1.0015, 1.0016],
    [1.0016, 1.0016, 1.0012, 1.0013],
    [1.0013, 1.0014, 1.0010, 1.0011],   // A
    [1.0011, 1.0012, 1.0008, 1.0012],   // B (sweeps to 1.0008, reclaims, closes up)
  ]);
  const f = detectTwoCandleFailure(pb, refBUY, ATR);
  assert.equal(f.valid, true);
  assert.equal(f.type, 'BUY_SWEEP');
});

test('bearish stall failure', () => {
  const pb = mk([
    [0.9970, 0.9975, 0.9970, 0.9974],
    [0.9974, 0.9980, 0.9974, 0.9979],
    [0.9979, 0.9986, 0.9979, 0.9985],
    [0.9985, 0.9989, 0.9985, 0.9988],
    [0.9988, 0.9990, 0.9987, 0.9989],   // A
    [0.9989, 0.9990, 0.9987, 0.9988],   // B (stall: high holds, closes down)
  ]);
  const f = detectTwoCandleFailure(pb, refSELL, ATR);
  assert.equal(f.valid, true);
  assert.equal(f.type, 'SELL_STALL');
});

test('bearish sweep-and-reclaim failure', () => {
  const pb = mk([
    [0.9970, 0.9975, 0.9970, 0.9974],
    [0.9974, 0.9980, 0.9974, 0.9979],
    [0.9979, 0.9986, 0.9979, 0.9985],
    [0.9985, 0.9989, 0.9985, 0.9988],
    [0.9988, 0.9990, 0.9987, 0.9989],   // A
    [0.9989, 0.9992, 0.9987, 0.9988],   // B (sweeps to 0.9992, closes back below A high & close)
  ]);
  const f = detectTwoCandleFailure(pb, refSELL, ATR);
  assert.equal(f.valid, true);
  assert.equal(f.type, 'SELL_SWEEP');
});

test('excessive penetration is rejected', () => {
  const pb = mk([
    [1.0030, 1.0030, 1.0025, 1.0026],
    [1.0026, 1.0026, 1.0020, 1.0021],
    [1.0021, 1.0021, 1.0015, 1.0016],
    [1.0016, 1.0016, 1.0012, 1.0013],
    [1.0013, 1.0014, 1.0010, 1.0011],   // A
    [1.0011, 1.0012, 1.0007, 1.0012],   // B penetrates 0.0003 (> 0.20 ATR)
  ]);
  assert.equal(detectTwoCandleFailure(pb, refBUY, ATR).valid, false);
});

test('failure pair away from the pullback extreme is rejected', () => {
  const pb = mk([
    [1.0030, 1.0030, 1.0025, 1.0026],
    [1.0026, 1.0026, 1.0000, 1.0016],   // deep spike low 1.0000 (the true pullback low)
    [1.0016, 1.0018, 1.0015, 1.0017],
    [1.0017, 1.0018, 1.0015, 1.0016],
    [1.0016, 1.0017, 1.0015, 1.0016],   // A (low 1.0015)
    [1.0016, 1.0017, 1.0015, 1.0016],   // B (low 1.0015, far above pullback low 1.0000)
  ]);
  const f = detectTwoCandleFailure(pb, refBUY, ATR);
  assert.equal(f.valid, false);
  assert.equal(f.reason, 'PAIR_NOT_AT_EXTREME');
});
