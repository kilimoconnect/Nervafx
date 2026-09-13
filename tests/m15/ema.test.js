'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateEMA } = require('../../api/_m15/ema');
const { mk, flat } = require('./_helpers');

function trend(n, base = 1.1000, step = 0.0006, startIdx = 0) {
  const out = []; let p = base;
  for (let i = 0; i < n; i++) { const o = p; p += step; out.push(mk(startIdx + i, o, Math.max(o, p) + 0.00003, Math.min(o, p) - 0.00003, p)); }
  return out;
}
/** Down for `d` candles then up for `u` — a V that turns before EMA20 crosses EMA50. */
function vshape(d, u, base = 1.1200, step = 0.0006) {
  const down = trend(d, base, -step, 0);
  const startP = down[down.length - 1].close;
  const up = trend(u, startP, step * 1.1, d);
  return down.concat(up);
}

test('flat market ⇒ FLAT or COMPRESSED, and never emits a trade signal', () => {
  const r = evaluateEMA(flat(120), { pair: 'EUR_USD' });
  assert.ok(['FLAT', 'COMPRESSED'].includes(r.state));
  assert.ok(!('signal' in r) && !('entry' in r), 'EMA engine must not emit trade signals (§17)');
});

test('strong uptrend ⇒ BULLISH_ESTABLISHED, price above both EMAs', () => {
  const r = evaluateEMA(trend(140), { pair: 'EUR_USD' });
  assert.ok(['BULLISH_ESTABLISHED', 'BULLISH_DEVELOPING', 'BULLISH_OVEREXTENDED'].includes(r.state));
  assert.equal(r.priceVsEma20, 'ABOVE');
  assert.equal(r.priceVsEma50, 'ABOVE');
  assert.ok(r.slope20 > 0);
});

test('EARLY transition is detected BEFORE the EMA20/EMA50 crossover (§17)', () => {
  // 70 down then 20 up: EMA20 slope has turned up but EMA20 is still below EMA50.
  const r = evaluateEMA(vshape(70, 20), { pair: 'EUR_USD' });
  assert.ok(r.ema20 < r.ema50, 'no crossover yet (EMA20 still below EMA50)');
  assert.equal(r.state, 'EARLY_BULLISH_TURN');
});

test('overextension: price far above EMA20 ⇒ BULLISH_OVEREXTENDED', () => {
  const c = trend(140);
  // add a spike leg to push price far above EMA20
  const last = c[c.length - 1].close;
  for (let k = 0; k < 3; k++) c.push(mk(c.length, last + k * 0.004, last + (k + 1) * 0.004 + 0.001, last + k * 0.004, last + (k + 1) * 0.004));
  const r = evaluateEMA(c, { pair: 'EUR_USD' });
  assert.ok(r.distanceFromEma20Vol > 2, 'price should be far above EMA20');
  assert.equal(r.state, 'BULLISH_OVEREXTENDED');
});

test('deterministic', () => {
  const c = trend(120);
  assert.deepEqual(evaluateEMA(c, { pair: 'EUR_USD' }), evaluateEMA(c, { pair: 'EUR_USD' }));
});
