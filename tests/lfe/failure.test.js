'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { detectLevelFailures, mergeEvents } = require('../../api/_lfe-failure');
const { SETUP_TYPE, DIRECTION, FAILED_SIDE, EVENT_STATE, ORIENTATION, LEVEL_TYPE } = require('../../api/_lfe-constants');

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 3, 0, 0, 0);
const ATR = 0.0010;              // injected H1 ATR (10 pips); zw = 0.05*ATR = 0.5 pip
const L = 1.10000;

// rows are [open, high, low, close]; openMs assigned by position.
function mk(rows) {
  return rows.map((r, i) => ({
    openMs: T0 + i * HOUR, time: new Date(T0 + i * HOUR).toISOString(),
    open: r[0], high: r[1], low: r[2], close: r[3],
  }));
}
const resistance = { pair: 'EUR_USD', levelType: LEVEL_TYPE.SWING_HIGH, orientation: ORIENTATION.RESISTANCE, centre: L, score: 12, availableAtMs: 0 };
const support = { pair: 'EUR_USD', levelType: LEVEL_TYPE.SWING_LOW, orientation: ORIENTATION.SUPPORT, centre: L, score: 12, availableAtMs: 0 };
const bySetup = (evs, type, dir) => evs.find((e) => e.setupType === type && e.direction === dir);

test('IMMEDIATE failed buyers → SELL', () => {
  const cs = mk([
    [1.09850, 1.09930, 1.09840, 1.09920], // bullish
    [1.09920, 1.10000, 1.09910, 1.09990], // bullish
    [1.09990, 1.10030, 1.09950, 1.09960], // spike above L, close below → reject
  ]);
  const ev = bySetup(detectLevelFailures(cs, null, ATR, resistance, 'EUR_USD'), SETUP_TYPE.IMMEDIATE, DIRECTION.SELL);
  assert.ok(ev);
  assert.equal(ev.failedSide, FAILED_SIDE.BUYERS);
  assert.equal(ev.state, EVENT_STATE.FAILURE_CONFIRMED);
  assert.equal(ev.failureAtMs, cs[2].openMs + HOUR);
  assert.equal(ev.sweepExtreme, 1.10030);
});

test('IMMEDIATE failed sellers → BUY', () => {
  const cs = mk([
    [1.10150, 1.10160, 1.10080, 1.10090], // bearish
    [1.10090, 1.10100, 1.10010, 1.10020], // bearish
    [1.10020, 1.10060, 1.09970, 1.10050], // spike below L, close above → reject
  ]);
  const ev = bySetup(detectLevelFailures(cs, null, ATR, support, 'EUR_USD'), SETUP_TYPE.IMMEDIATE, DIRECTION.BUY);
  assert.ok(ev);
  assert.equal(ev.failedSide, FAILED_SIDE.SELLERS);
  assert.equal(ev.state, EVENT_STATE.FAILURE_CONFIRMED);
  assert.equal(ev.sweepExtreme, 1.09970);
});

test('DELAYED failed buyers → SELL, return on the NEXT candle', () => {
  const cs = mk([
    [1.09900, 1.09990, 1.09890, 1.09980], // build-up
    [1.09980, 1.10080, 1.09970, 1.10060], // breakout, closes above zone
    [1.10060, 1.10070, 1.09930, 1.09950], // returns below zone (offset 1)
  ]);
  const ev = bySetup(detectLevelFailures(cs, null, ATR, resistance, 'EUR_USD'), SETUP_TYPE.DELAYED, DIRECTION.SELL);
  assert.ok(ev);
  assert.equal(ev.state, EVENT_STATE.FAILURE_CONFIRMED);
  assert.equal(ev.returnOffset, 1);
  assert.equal(ev.breakoutAtMs, cs[1].openMs + HOUR);
  assert.ok(ev.qualityPoints > 0);
});

test('DELAYED failed buyers → SELL, return on the SECOND candle', () => {
  const cs = mk([
    [1.09900, 1.09990, 1.09890, 1.09980],
    [1.09980, 1.10080, 1.09970, 1.10060], // breakout
    [1.10060, 1.10090, 1.10030, 1.10070], // holds above (no return)
    [1.10070, 1.10080, 1.09930, 1.09950], // returns below zone (offset 2)
  ]);
  const ev = bySetup(detectLevelFailures(cs, null, ATR, resistance, 'EUR_USD'), SETUP_TYPE.DELAYED, DIRECTION.SELL);
  assert.ok(ev);
  assert.equal(ev.state, EVENT_STATE.FAILURE_CONFIRMED);
  assert.equal(ev.returnOffset, 2);
});

test('DELAYED failed sellers → BUY, return on the NEXT candle', () => {
  const cs = mk([
    [1.10100, 1.10110, 1.10010, 1.10020], // build-down
    [1.10020, 1.10030, 1.09920, 1.09940], // breakdown, closes below zone
    [1.09940, 1.10080, 1.09930, 1.10060], // returns above zone (offset 1)
  ]);
  const ev = bySetup(detectLevelFailures(cs, null, ATR, support, 'EUR_USD'), SETUP_TYPE.DELAYED, DIRECTION.BUY);
  assert.ok(ev);
  assert.equal(ev.state, EVENT_STATE.FAILURE_CONFIRMED);
  assert.equal(ev.returnOffset, 1);
  assert.equal(ev.failedSide, FAILED_SIDE.SELLERS);
});

test('DELAYED failed sellers → BUY, return on the SECOND candle', () => {
  const cs = mk([
    [1.10100, 1.10110, 1.10010, 1.10020],
    [1.10020, 1.10030, 1.09920, 1.09940], // breakdown
    [1.09940, 1.09960, 1.09900, 1.09930], // holds below (no return)
    [1.09930, 1.10080, 1.09920, 1.10060], // returns above zone (offset 2)
  ]);
  const ev = bySetup(detectLevelFailures(cs, null, ATR, support, 'EUR_USD'), SETUP_TYPE.DELAYED, DIRECTION.BUY);
  assert.ok(ev);
  assert.equal(ev.state, EVENT_STATE.FAILURE_CONFIRMED);
  assert.equal(ev.returnOffset, 2);
});

test('ACCEPTED breakout — held above the zone through both candles', () => {
  const cs = mk([
    [1.09900, 1.09990, 1.09890, 1.09980],
    [1.09980, 1.10080, 1.09970, 1.10060], // breakout
    [1.10060, 1.10090, 1.10040, 1.10070], // held above
    [1.10070, 1.10100, 1.10050, 1.10085], // held above
  ]);
  const evs = detectLevelFailures(cs, null, ATR, resistance, 'EUR_USD');
  const breakout = evs.find((e) => e.setupType === SETUP_TYPE.DELAYED && e.breakoutAtMs === cs[1].openMs + HOUR);
  assert.ok(breakout);
  assert.equal(breakout.state, EVENT_STATE.ACCEPTED);
  assert.ok(!evs.some((e) => e.state === EVENT_STATE.FAILURE_CONFIRMED)); // no SELL candidate
});

test('DELAYED_FAILURE_PENDING — follow-up candles have not closed yet', () => {
  const cs = mk([
    [1.09900, 1.09990, 1.09890, 1.09980],
    [1.09980, 1.10080, 1.09970, 1.10060], // breakout, nothing after it yet
  ]);
  const ev = bySetup(detectLevelFailures(cs, null, ATR, resistance, 'EUR_USD'), SETUP_TYPE.DELAYED, DIRECTION.SELL);
  assert.ok(ev);
  assert.equal(ev.state, EVENT_STATE.DELAYED_FAILURE_PENDING);
  assert.equal(ev.failureAtMs, null);
});

test('weak attack is rejected — no 0.80 ATR run-up', () => {
  const cs = mk([
    [1.09990, 1.10000, 1.09980, 1.09985], // small bearish, near L
    [1.09985, 1.09995, 1.09975, 1.09980], // small bearish
    [1.10000, 1.10030, 1.09960, 1.09965], // reject shape, but no buyer attack into it
  ]);
  const evs = detectLevelFailures(cs, null, ATR, resistance, 'EUR_USD');
  assert.equal(evs.length, 0);
});

test('a duplicate scan does not duplicate events', () => {
  const cs = mk([
    [1.09850, 1.09930, 1.09840, 1.09920],
    [1.09920, 1.10000, 1.09910, 1.09990],
    [1.09990, 1.10030, 1.09950, 1.09960],
  ]);
  const first = detectLevelFailures(cs, null, ATR, resistance, 'EUR_USD');
  const second = detectLevelFailures(cs, null, ATR, resistance, 'EUR_USD');
  const merged = mergeEvents(first, second);
  assert.equal(merged.length, first.length);
  assert.deepEqual(first.map((e) => e.eventKey), second.map((e) => e.eventKey));
});
