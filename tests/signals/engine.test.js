'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { runStrategy, summarize, memStore } = require('../../src/signalEngine');
const { strategyDef, TF_MS } = require('../../research/signals/config');
const { genFiring } = require('./fixtures');

const M15 = TF_MS.M15;

function lowCostDef() {
  const def = strategyDef('today');
  def.costs = Object.assign({}, def.costs, { spreadPips: {}, defaultSpreadPips: 0, slippagePips: 0, swapPipsPerDayLong: 0, swapPipsPerDayShort: 0 });
  return def;
}

test('engine fires exactly one signal end-to-end; BUY direction drives the correct outcome', () => {
  const { baseByPair, monByPair, lastDataMs } = genFiring();
  const def = lowCostDef();
  const r = runStrategy(def, baseByPair, monByPair, lastDataMs, memStore(), 'historical');
  assert.ok(r.ok);
  assert.equal(r.trades.length, 1, 'exactly one engineered signal');
  const t = r.trades[0];
  assert.equal(t.signal.pair, 'AUD_JPY');
  assert.equal(t.signal.direction, 'BUY');
  assert.equal(t.status, 'CLOSED');
  assert.equal(t.exitReason, 'TARGET');            // regression guard: direction must reach the monitor
  assert.ok(Math.abs(t.netR - 2) < 1e-6, 'a clean 2R win at target (zero-cost fixture)');
});

test('holding window is 16 entry candles (entry candle = #1)', () => {
  const { baseByPair, monByPair, lastDataMs } = genFiring();
  const r = runStrategy(lowCostDef(), baseByPair, monByPair, lastDataMs, memStore(), 'historical');
  const t = r.trades[0];
  assert.ok(t.exitMs > t.fillMs);
  assert.ok(t.exitMs <= t.fillMs + 16 * M15, 'exit no later than the 16th entry candle close');
});

test('no duplicate signals + restart recovery: re-running with the same store yields nothing', () => {
  const { baseByPair, monByPair, lastDataMs } = genFiring();
  const def = lowCostDef();
  const store = memStore();
  const r1 = runStrategy(def, baseByPair, monByPair, lastDataMs, store, 'historical');
  assert.equal(r1.trades.length, 1);
  const r2 = runStrategy(def, baseByPair, monByPair, lastDataMs, store, 'forward');   // store persists seen keys
  assert.equal(r2.trades.length, 0, 'already-recorded signal is not duplicated after restart');
});

test('historical/live parity: identical data → identical decisions regardless of origin label', () => {
  const { baseByPair, monByPair, lastDataMs } = genFiring();
  const def = lowCostDef();
  const hist = runStrategy(def, baseByPair, monByPair, lastDataMs, memStore(), 'historical');
  const live = runStrategy(def, baseByPair, monByPair, lastDataMs, memStore(), 'forward');
  const shape = (r) => r.trades.map((t) => ({ pair: t.signal.pair, dir: t.signal.direction, entry: t.signal.entryCloseMs, status: t.status, reason: t.exitReason, netR: t.netR }));
  assert.deepEqual(shape(hist), shape(live));
});

test('summary win-rate denominator excludes pending/open/expired/cancelled', () => {
  const { baseByPair, monByPair, lastDataMs } = genFiring();
  const s = summarize(runStrategy(lowCostDef(), baseByPair, monByPair, lastDataMs, memStore(), 'historical').trades);
  assert.equal(s.closed, 1); assert.equal(s.wins, 1); assert.equal(s.winRate, 100);
});
