'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { triggerBreak, decideSignal } = require('../../research/breakout/trigger');
const { candles } = require('./fixtures');

// strength maps at the trigger close
const BUY_OK = { EUR: { classification: 'strong' }, USD: { classification: 'weak' } };
const SELL_OK = { EUR: { classification: 'weak' }, USD: { classification: 'strong' } };

const bullTrigger = () => triggerBreak(candles([{ o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 11.6, l: 10, c: 11.4 }]));   // close 11.4 > prev high 11
const bearTrigger = () => triggerBreak(candles([{ o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 10.1, l: 8.5, c: 8.8 }]));   // close 8.8 < prev low 9
const noTrigger  = () => triggerBreak(candles([{ o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 10.9, l: 9.2, c: 10.2 }]));   // inside

test('fresh bullish trigger + BUY candidate + base strong/quote weak → BUY signal', () => {
  const d = decideSignal('BUY', bullTrigger(), BUY_OK, 'EUR', 'USD');
  assert.equal(d.signal, 'BUY');
  assert.equal(d.reason, 'signal');
});

test('fresh bearish trigger + SELL candidate + base weak/quote strong → SELL signal', () => {
  const d = decideSignal('SELL', bearTrigger(), SELL_OK, 'EUR', 'USD');
  assert.equal(d.signal, 'SELL');
});

test('no breakout on the latest completed trigger candle → no signal', () => {
  const d = decideSignal('BUY', noTrigger(), BUY_OK, 'EUR', 'USD');
  assert.equal(d.signal, null);
  assert.equal(d.reason, 'no-signal:no-breakout');
});

test('a break AGAINST the qualified direction does not authorise the opposite trade', () => {
  // BUY candidate but the trigger candle broke DOWN
  const d = decideSignal('BUY', bearTrigger(), BUY_OK, 'EUR', 'USD');
  assert.equal(d.signal, null);
  assert.equal(d.reason, 'no-signal:breakout-against-direction');
});

test('qualification re-checked at the trigger close: lost qualification → no signal', () => {
  // bullish trigger + BUY candidate, but at the trigger close EUR is no longer strong
  const lost = { EUR: { classification: 'neutral' }, USD: { classification: 'weak' } };
  const d = decideSignal('BUY', bullTrigger(), lost, 'EUR', 'USD');
  assert.equal(d.signal, null);
  assert.equal(d.reason, 'no-signal:qualification-lost');
});

test('incomplete currency data at the trigger close → cannot evaluate (distinct from no-signal)', () => {
  const incomplete = { EUR: { classification: 'insufficient' }, USD: { classification: 'weak' } };
  const d = decideSignal('BUY', bullTrigger(), incomplete, 'EUR', 'USD');
  assert.equal(d.signal, null);
  assert.equal(d.reason, 'cannot-evaluate:incomplete-data');
  assert.equal(d.evaluable, false);
});

test('insufficient trigger history → cannot evaluate', () => {
  const tb = triggerBreak(candles([{ o: 10, h: 11, l: 9, c: 10 }]));
  const d = decideSignal('BUY', tb, BUY_OK, 'EUR', 'USD');
  assert.equal(d.reason, 'cannot-evaluate:insufficient-history');
});

test('triggerBreak reports the broken boundary and level', () => {
  const tb = bullTrigger();
  assert.equal(tb.break, 1);
  assert.equal(tb.boundary, 'high');
  assert.equal(tb.level, 11);
});
