'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { simulateTrade } = require('../../research/paw1h4/trade');
const { CONFIG, H4_MS } = require('../../research/paw1h4/config');

const cfg = Object.assign({}, CONFIG);
const base = { dir: 'BUY', pair: 'EUR_USD', entryBarIdx: 0, entryOpenMs: 0, entryPrice: 1.1000, stopRef: 1.0950, pullbackExtreme: 1.0940, signalCloseMs: 0 };
function bar(i, o, h, l, c) { return { openMs: i * H4_MS, closeMs: (i + 1) * H4_MS, open: o, high: h, low: l, close: c }; }

test('accepted BUY, target hit → positive R', () => {
  const cands = [bar(0, 1.1000, 1.1050, 1.0990, 1.1040), bar(1, 1.1040, 1.1160, 1.1030, 1.1150)];
  const t = simulateTrade(base, cands, { highs: [1.1150], lows: [1.0800] }, cfg);
  assert.equal(t.accepted, true);
  assert.equal(t.target, 1.1150);
  assert.ok(t.stop < base.stopRef, 'stop placed beyond structure by the buffer');
  assert.equal(t.exit.reason, 'target');
  assert.ok(t.R > 0 && t.win);
  assert.ok(t.rrPlanned >= cfg.minRewardRisk);
});

test('stop hit → negative R', () => {
  const cands = [bar(0, 1.1000, 1.1010, 1.0945, 1.0960)];
  const t = simulateTrade(base, cands, { highs: [1.1150], lows: [1.0800] }, cfg);
  assert.equal(t.exit.reason, 'stop');
  assert.ok(t.R < 0 && !t.win);
});

test('stop and target in one candle → conservative stop-first, flagged', () => {
  const cands = [bar(0, 1.1000, 1.1160, 1.0945, 1.1100)];
  const t = simulateTrade(base, cands, { highs: [1.1150], lows: [1.0800] }, cfg);
  assert.equal(t.exit.reason, 'stop_ambiguous');
  assert.equal(t.ambiguous, true);
  assert.ok(t.R < 0);
});

test('reject when no eligible weekly target beyond entry', () => {
  const cands = [bar(0, 1.1000, 1.1050, 1.0990, 1.1040)];
  const t = simulateTrade(base, cands, { highs: [], lows: [1.0800] }, cfg);
  assert.equal(t.accepted, false);
  assert.equal(t.rejectReason, 'no_target');
});

test('reject when estimated R:R after costs below the minimum', () => {
  const cands = [bar(0, 1.1000, 1.1050, 1.0990, 1.1040)];
  const t = simulateTrade(base, cands, { highs: [1.1020], lows: [1.0800] }, cfg); // ~20p reward vs ~53p risk
  assert.equal(t.accepted, false);
  assert.equal(t.rejectReason, 'rr_below_min');
});

test('gap through stop at the entry open invalidates the trade', () => {
  const cands = [bar(0, 1.0940, 1.0960, 1.0930, 1.0950)];  // opens below the stop
  const t = simulateTrade(base, cands, { highs: [1.1150], lows: [1.0800] }, cfg);
  assert.equal(t.accepted, false);
  assert.equal(t.rejectReason, 'gap_through_stop');
});

test('time exit after the max holding window', () => {
  const cands = [];
  for (let i = 0; i < cfg.exitH4Bars; i++) cands.push(bar(i, 1.1000, 1.1010, 1.0990, 1.1000)); // never hits either
  const t = simulateTrade(base, cands, { highs: [1.1150], lows: [1.0800] }, cfg);
  assert.equal(t.accepted, true);
  assert.equal(t.exit.reason, 'time');
  assert.equal(t.barsHeld, cfg.exitH4Bars);
});
