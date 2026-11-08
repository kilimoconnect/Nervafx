'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { wilderATR } = require('../../research/signals/atr');
const { evaluateTrigger } = require('../../research/signals/trigger');
const { strategyDef, TF_MS } = require('../../research/signals/config');

const M15 = TF_MS.M15;
const params = strategyDef('today').params;

/** 14 seed candles with TR=1 (ATR seeds at 1), then three supplied pattern candles. */
function series(pattern) {
  const cs = []; let t = Date.UTC(2025, 4, 1);
  // candle 0 (no TR), then 16 warm-up candles range 1 around 100
  cs.push({ time: t, open: 100, high: 100.5, low: 99.5, close: 100 }); t += M15;
  for (let i = 0; i < 16; i++) { cs.push({ time: t, open: 100, high: 100.5, low: 99.5, close: 100 }); t += M15; }
  for (const p of pattern) { cs.push(Object.assign({ time: t }, p)); t += M15; }
  return cs;
}

test('Wilder ATR(14) seeds at the mean of the first 14 TRs', () => {
  const cs = series([]);
  const { last } = wilderATR(cs, 14);
  assert.ok(Math.abs(last - 1) < 1e-9, 'ATR = 1 for uniform TR=1 series');
});

test('valid BUY trigger: two bearish, bullish close above prior high, stop/target per formula', () => {
  const cs = series([
    { open: 100.4, high: 100.5, low: 99.6, close: 99.8 },   // t-2 bearish
    { open: 99.8,  high: 99.9,  low: 99.2, close: 99.3 },    // t-1 bearish
    { open: 99.3,  high: 100.3, low: 99.3, close: 100.2 },   // t bullish, close>99.9 (t-1 high)
  ]);
  const res = evaluateTrigger(cs, 'BUY', params);
  assert.ok(res.pass, 'trigger passes: ' + (res.reasons || []).join(', '));
  const atr = res.atr, p = res.plan;
  assert.equal(p.referenceEntry, 100.2);
  const expStop = Math.min(99.6, 99.2, 99.3) - params.stopAtrMult * atr;
  assert.ok(Math.abs(p.fixedStop - expStop) < 1e-9, 'stop = lowest low − 0.10·ATR');
  const risk = p.referenceEntry - p.fixedStop;
  assert.ok(Math.abs(p.referenceRisk - risk) < 1e-9);
  assert.ok(Math.abs(p.indicativeTarget - (p.referenceEntry + 2 * risk)) < 1e-9, 'target = entry + 2R');
  assert.ok(Math.abs(p.maxDeviation - 0.25 * atr) < 1e-9, 'deviation = 0.25·ATR');
});

test('valid SELL trigger mirrors the BUY rules', () => {
  const cs = series([
    { open: 99.6, high: 100.4, low: 99.5, close: 100.2 },    // t-2 bullish
    { open: 100.2, high: 100.8, low: 100.1, close: 100.7 },  // t-1 bullish
    { open: 100.7, high: 100.7, low: 99.7, close: 99.8 },    // t bearish, close<100.1 (t-1 low)
  ]);
  const res = evaluateTrigger(cs, 'SELL', params);
  assert.ok(res.pass, 'SELL trigger passes: ' + (res.reasons || []).join(', '));
  assert.ok(res.plan.fixedStop > res.plan.referenceEntry, 'SELL stop above entry');
  assert.ok(res.plan.indicativeTarget < res.plan.referenceEntry, 'SELL target below entry');
});

test('rejects when candle-t range exceeds 2.0·ATR', () => {
  const cs = series([
    { open: 100.4, high: 100.5, low: 99.6, close: 99.8 },
    { open: 99.8,  high: 99.9,  low: 99.2, close: 99.3 },
    { open: 99.3,  high: 103.5, low: 99.3, close: 100.2 },   // range 4.2 > 2·ATR(≈1)
  ]);
  const res = evaluateTrigger(cs, 'BUY', params);
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => /range/.test(r)), 'range rejection reason present');
});

test('rejects when the 3-candle pattern is absent', () => {
  const cs = series([
    { open: 100.4, high: 100.5, low: 99.6, close: 99.8 },    // t-2 bearish
    { open: 99.8,  high: 100.3, low: 99.7, close: 100.1 },   // t-1 bullish (breaks the rule)
    { open: 100.1, high: 100.3, low: 99.3, close: 100.2 },
  ]);
  const res = evaluateTrigger(cs, 'BUY', params);
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => /t-1 not bearish/.test(r)));
});
