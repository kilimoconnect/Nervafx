'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runEngine } = require('../../research/paw1h4/engine');
const { CONFIG, H4_MS } = require('../../research/paw1h4/config');

const START = Date.UTC(2026, 0, 5, 0, 0, 0);
function bars(rows) {
  // rows: [high, low, close?] per H4 bar
  return rows.map((r, i) => {
    const openMs = START + i * H4_MS;
    const high = r[0], low = r[1], close = r[2] != null ? r[2] : (high + low) / 2;
    return { openMs, closeMs: openMs + H4_MS, open: (high + low) / 2, high, low, close };
  });
}
const cfg = Object.assign({}, CONFIG, { pair: 'EUR_USD', swing: { left: 2, right: 2 } });

// A clean bullish pullback → first break → retest structure → continuation BUY.
// Pivots: H1@2=12, L1@4=7, H2@6=11 (LH), L2@8=6 (LL); break@10 close>11; SH@12=13;
// HL@14 low=8.5 (>pullback low 6); trigger close@17 > 13; entry @ bar18 open.
const BUY_ROWS = [
  [10.0, 9.0], [10.2, 9.2], [12.0, 9.5], [10.5, 9.0], [10.0, 7.0],
  [10.3, 8.5], [11.0, 8.0], [9.8, 7.5], [9.5, 6.0], [10.0, 6.5],
  [12.5, 7.0, 12.0], [11.5, 9.0], [13.0, 9.5], [12.0, 9.0], [12.2, 8.5],
  [12.5, 9.2], [12.8, 9.4], [13.5, 10.0, 13.3], [13.6, 10.5],
];
const bullWeekly = { biasAt: () => ({ bias: 'BULLISH', eligibilityStartMs: START - 1, invalidationLevel: 1 }), levelsAsOf: () => ({ highs: [], lows: [] }) };

test('clean bullish sequence emits exactly one BUY with correct frozen levels', () => {
  const { opportunities } = runEngine(bars(BUY_ROWS), bullWeekly, cfg);
  assert.equal(opportunities.length, 1);
  const o = opportunities[0];
  assert.equal(o.dir, 'BUY');
  assert.equal(o.breakLevel, 11.0);
  assert.equal(o.pullbackExtreme, 6.0);
  assert.equal(o.trigger, 13.0);
  assert.equal(o.stopRef, 8.5);
  assert.equal(o.signalBarIdx, 17);
  assert.equal(o.entryBarIdx, 18);
  assert.equal(o.entryPrice, (13.6 + 10.5) / 2);   // next H4 open = that bar's mid open
});

// Mirror the exact scenario around 20 (swap highs/lows) → a bearish SELL.
function mirror(rows) {
  return rows.map((r) => {
    const high = 20 - r[1], low = 20 - r[0];
    const close = r[2] != null ? 20 - r[2] : undefined;
    return close != null ? [high, low, close] : [high, low];
  });
}
const bearWeekly = { biasAt: () => ({ bias: 'BEARISH', eligibilityStartMs: START - 1, invalidationLevel: 99 }), levelsAsOf: () => ({ highs: [], lows: [] }) };

test('long/short symmetry: mirrored scenario emits one SELL with mirrored levels', () => {
  const { opportunities } = runEngine(bars(mirror(BUY_ROWS)), bearWeekly, cfg);
  assert.equal(opportunities.length, 1);
  const o = opportunities[0];
  assert.equal(o.dir, 'SELL');
  assert.equal(o.breakLevel, 20 - 11.0);    // 9.0
  assert.equal(o.pullbackExtreme, 20 - 6.0); // 14.0
  assert.equal(o.trigger, 20 - 13.0);        // 7.0
  assert.equal(o.stopRef, 20 - 8.5);         // 11.5
  assert.equal(o.entryPrice, ((20 - 10.5) + (20 - 13.6)) / 2);   // mirrored next-open mid = 7.95
});

test('as-of stability: appending future candles does not change the emitted signal', () => {
  const full = bars(BUY_ROWS.concat([[14.0, 11.0], [14.2, 11.2], [13.0, 10.0]]));
  const base = runEngine(bars(BUY_ROWS), bullWeekly, cfg).opportunities[0];
  const ext = runEngine(full, bullWeekly, cfg).opportunities[0];
  assert.deepEqual({ s: base.signalCloseMs, t: base.trigger, e: base.entryPrice }, { s: ext.signalCloseMs, t: ext.trigger, e: ext.entryPrice });
});

function cancelReasons(log) { return log.filter((e) => e.cancelReason).map((e) => e.cancelReason); }

test('cancel: an H4 candle breaching the frozen pullback extreme kills the setup', () => {
  const rows = BUY_ROWS.slice();
  rows[11] = [11.5, 5.5];                       // after FIRST_BREAK, dips below pullback low (6.0)
  const { opportunities, log } = runEngine(bars(rows), bullWeekly, cfg);
  assert.equal(opportunities.length, 0);
  assert.ok(cancelReasons(log).includes('pullback_extreme_breached'));
});

test('cancel: once ARMED, breaching the stop reference kills the setup (no trigger)', () => {
  const rows = BUY_ROWS.slice();
  rows[17] = [9.0, 8.0, 8.5];                   // low 8.0 < stopRef 8.5, close below trigger
  const { opportunities, log } = runEngine(bars(rows), bullWeekly, cfg);
  assert.equal(opportunities.length, 0);
  assert.ok(cancelReasons(log).includes('stop_reference_breached'));
});

test('cancellation takes priority over trigger in the same candle', () => {
  const rows = BUY_ROWS.slice();
  rows[17] = [13.5, 8.0, 13.3];                 // breaches stop AND closes above trigger same bar
  const { opportunities, log } = runEngine(bars(rows), bullWeekly, cfg);
  assert.equal(opportunities.length, 0, 'no entry when cancellation and trigger coincide');
  assert.ok(cancelReasons(log).includes('stop_reference_breached'));
});

test('cancel: losing weekly eligibility kills an in-flight setup', () => {
  const flip = { biasAt: (t) => ({ bias: t > START + 11 * H4_MS ? 'NEUTRAL' : 'BULLISH', eligibilityStartMs: START - 1, invalidationLevel: 1 }), levelsAsOf: () => ({ highs: [], lows: [] }) };
  const { opportunities, log } = runEngine(bars(BUY_ROWS), flip, cfg);
  assert.equal(opportunities.length, 0);
  assert.ok(cancelReasons(log).includes('weekly_eligibility_lost'));
});

test('expiry: 30 completed H4 bars after FIRST_BREAK with no arming → EXPIRED', () => {
  const flat = []; for (let i = 0; i < 32; i++) flat.push([10.5, 9.5]);  // no new structure
  const rows = BUY_ROWS.slice(0, 11).concat(flat);                        // FIRST_BREAK at bar 10
  const { opportunities, log } = runEngine(bars(rows), bullWeekly, cfg);
  assert.equal(opportunities.length, 0);
  assert.ok(log.some((e) => e.state === 'EXPIRED'));
});

test('no-backdate: a close above the trigger ON the arming bar does not enter; waits for the next', () => {
  const rows = BUY_ROWS.slice();
  rows[16] = [13.5, 9.4, 13.3];                 // arming bar already closes above the trigger
  const { opportunities } = runEngine(bars(rows), bullWeekly, cfg);
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].signalBarIdx, 17, 'entry waits for a fresh close after confirmation');
});
