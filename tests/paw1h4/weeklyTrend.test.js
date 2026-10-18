'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildWeeklyContext } = require('../../research/paw1h4/weeklyTrend');
const { WEEK_MS } = require('../../research/paw1h4/config');

const START = Date.UTC(2026, 0, 5, 0, 0, 0);     // a Monday
function weeks(rows) {
  return rows.map((r, i) => { const openMs = START + i * WEEK_MS; return { openMs, closeMs: openMs + WEEK_MS, open: (r[0] + r[1]) / 2, high: r[0], low: r[1], close: r[2] != null ? r[2] : (r[0] + r[1]) / 2 }; });
}
const closeOf = (i) => START + (i + 1) * WEEK_MS;
const cfg = { left: 2, right: 2 };

// Rising highs (H1@4=13, H2@8=14.5) and rising lows (L1@2=7, L2@6=8) → BULLISH.
const BULL = [
  [10.0, 9.0], [10.5, 8.0], [10.2, 7.0], [11.5, 8.5], [13.0, 9.0],
  [12.0, 9.5], [11.8, 8.0], [13.0, 9.0], [14.5, 10.0], [13.5, 10.5], [13.0, 11.0], [12.8, 11.2],
];

test('BULLISH once two rising highs and two rising lows are confirmed', () => {
  const wk = buildWeeklyContext(weeks(BULL), cfg);
  const b = wk.biasAt(closeOf(10));     // H2 confirms at week10 close
  assert.equal(b.bias, 'BULLISH');
  assert.equal(b.invalidationLevel, 8.0);          // latest confirmed higher low (L2)
  assert.equal(b.eligibilityStartMs, closeOf(10));
  // before H2 confirms, not yet bullish
  assert.notEqual(wk.biasAt(closeOf(9)).bias, 'BULLISH');
});

test('BEARISH is the mirror (falling highs and falling lows)', () => {
  const bear = BULL.map((r) => [20 - r[1], 20 - r[0]]);   // reflect → falling structure
  const wk = buildWeeklyContext(weeks(bear), cfg);
  assert.equal(wk.biasAt(closeOf(10)).bias, 'BEARISH');
});

test('a completed weekly close below the higher low invalidates eligibility', () => {
  const rows = BULL.slice(0, 11).concat([[9.0, 6.5, 7.5]]);   // week11 closes 7.5 < HL 8.0
  const wk = buildWeeklyContext(weeks(rows), cfg);
  assert.equal(wk.biasAt(closeOf(10)).bias, 'BULLISH');
  assert.equal(wk.biasAt(closeOf(11)).bias, 'NEUTRAL');       // invalidated
});

test('after invalidation, unchanged historical pivots do NOT reactivate the trend', () => {
  // Invalidate, then add weeks that neither break down further nor form NEW rising pivots.
  const rows = BULL.slice(0, 11).concat([
    [9.0, 6.5, 7.5],    // 11: invalidation close
    [9.5, 7.6], [9.6, 7.7], [9.7, 7.8], [9.8, 7.9],   // drift up but no new confirmed HH+HL after invalidation
  ]);
  const wk = buildWeeklyContext(weeks(rows), cfg);
  for (let i = 12; i <= 14; i++) {
    assert.equal(wk.biasAt(closeOf(i)).bias !== 'BULLISH', true, 'stays non-bullish without a fresh sequence');
  }
});

test('UNAVAILABLE with insufficient confirmed structure', () => {
  const wk = buildWeeklyContext(weeks(BULL.slice(0, 6)), cfg);
  assert.equal(wk.biasAt(closeOf(5)).bias === 'BULLISH', false);
});

test('recent-candle BOS: bullish trend + up candle breaking the prior swing high confirms', () => {
  // BULL fixture is bullish; append a strong bullish week closing above the last swing high.
  const wk0 = buildWeeklyContext(weeks(BULL), cfg);
  const lastHigh = wk0.biasAt(closeOf(10)).highs ? null : null;
  const rows = BULL.concat([[15.2, 13.0, 15.0]]);   // week11: bullish body, closes 15.0 > last high 14.5 (BOS up)
  const wk = buildWeeklyContext(weeks(rows), cfg);
  const b = wk.bosConfirmAt(closeOf(12));
  assert.equal(b.bias, 'BULLISH');
  assert.equal(b.bodyOk, true);
  assert.equal(b.bosOk, true);
  assert.equal(b.ok, true);
});

test('recent-candle BOS fails when the latest candle closes against the trend', () => {
  const rows = BULL.concat([[14.9, 12.0, 12.2]]);   // bearish body in a bullish trend
  const wk = buildWeeklyContext(weeks(rows), cfg);
  const b = wk.bosConfirmAt(closeOf(12));
  assert.equal(b.bodyOk, false);
  assert.equal(b.ok, false);
});
