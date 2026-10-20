'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildMarketContext } = require('../../research/paw1h4/weeklyContext');
const { CONFIG, H1_MS } = require('../../research/paw1h4/config');

const START = Date.UTC(2025, 0, 6, 0, 0, 0);     // a Monday
// Build H1 from per-week center levels, with a small within-week wiggle so each week's
// high/low track the level and the weekly close ≈ the level (distinct weekly extremes).
function h1FromWeekly(levels, intra) {
  const out = []; let idx = 0;
  for (let w = 0; w < levels.length; w++) {
    for (let h = 0; h < 7 * 24; h++) {
      const c = levels[w] + (intra || 0.001) * Math.sin((h / (7 * 24)) * 2 * Math.PI);
      out.push({ openMs: START + idx * H1_MS, closeMs: START + (idx + 1) * H1_MS, open: c, high: c + 0.0003, low: c - 0.0003, close: c });
      idx++;
    }
  }
  return out;
}
const closeOfWeek = (w) => START + (w + 1) * 7 * 24 * H1_MS;

test('oscillating market → established weekly balance with upper/lower boundaries', () => {
  const levels = []; for (let w = 0; w < 22; w++) levels.push(1.1100 + 0.006 * Math.sin(w * Math.PI / 2));
  const ctx = buildMarketContext(h1FromWeekly(levels), closeOfWeek(20), CONFIG, 'EUR_USD');
  assert.ok(ctx.balance, 'a balance object is produced');
  assert.equal(ctx.balance.confirmed, true, 'balance confirmed from oscillation across both boundaries');
  assert.ok(ctx.balance.upper > ctx.balance.lower);
  assert.ok(ctx.balance.widthPips > 0);
  assert.ok(['INSIDE', 'AT_UPPER', 'AT_LOWER', 'ABOVE_UPPER', 'BELOW_LOWER'].includes(ctx.location.zone));
});

test('rising zig-zag trend → NOT an established balance', () => {
  const levels = []; for (let w = 0; w < 22; w++) levels.push(1.1000 + 0.0025 * w + 0.004 * Math.sin(w * Math.PI / 2));
  const ctx = buildMarketContext(h1FromWeekly(levels), closeOfWeek(20), CONFIG, 'EUR_USD');
  assert.equal(ctx.trend.bias, 'BULLISH');
  assert.ok(!ctx.balance || ctx.balance.confirmed === false, 'no established balance while trending');
});

test('context is causal: references only from completed weekly candles knowable by asOf', () => {
  const levels = []; for (let w = 0; w < 22; w++) levels.push(1.1100 + 0.006 * Math.sin(w * Math.PI / 2));
  const base = h1FromWeekly(levels);
  const asOf = closeOfWeek(12);
  const ctx = buildMarketContext(base, asOf, CONFIG, 'EUR_USD');
  for (const h of ctx.references.structuralHighs) assert.ok(Date.parse(h.knownUtc) <= asOf);
  for (const l of ctx.references.structuralLows) assert.ok(Date.parse(l.knownUtc) <= asOf);
  // appending future H1 must not change the as-of context balance/boundaries
  const future = []; for (let i = 0; i < 3 * 7 * 24; i++) { const c = 1.20 + 0.0005 * i; future.push({ openMs: base[base.length - 1].closeMs + i * H1_MS, closeMs: base[base.length - 1].closeMs + (i + 1) * H1_MS, open: c, high: c + 0.0003, low: c - 0.0003, close: c }); }
  const ctx2 = buildMarketContext(base.concat(future), asOf, CONFIG, 'EUR_USD');
  assert.equal(JSON.stringify(ctx.balance), JSON.stringify(ctx2.balance));
});
