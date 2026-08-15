'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { simulateOutcome } = require('../../api/_lfe-outcome');
const { computeMetrics, groupBy, variantKey, backtestReport, compareConfirmation, stabilityFlags } = require('../../api/_lfe-metrics');
const { createMemoryStore, runBackfill } = require('../../api/_lfe-backfill');
const { M15_MS } = require('../../api/_lfe-constants');

const T0 = Date.UTC(2026, 7, 3, 0, 0, 0);
const cMs = (i) => T0 + i * M15_MS;
const c = (i, o, h, l, cl) => ({ openMs: cMs(i), open: o, high: h, low: l, close: cl });

// ── Outcome simulation ──────────────────────────────────────────────────────
const sellPlan = { direction: 'SELL', entry: 1.09950, stop: 1.10040, target: 1.09770, entryMs: cMs(0) };

test('SELL hits target → WIN at ~2R', () => {
  const future = [c(0, 1.09950, 1.09960, 1.09900, 1.09910), c(1, 1.09910, 1.09920, 1.09760, 1.09780)];
  const o = simulateOutcome(sellPlan, future, {});
  assert.equal(o.status, 'WIN');
  assert.ok(o.resultR >= 1.9 && o.resultR <= 2.1);
  assert.ok(o.mfeR >= 2);
});

test('SELL hits stop → LOSS at ~-1R', () => {
  const future = [c(0, 1.09950, 1.10050, 1.09940, 1.10030)];
  const o = simulateOutcome(sellPlan, future, {});
  assert.equal(o.status, 'LOSS');
  assert.ok(o.resultR <= -0.9 && o.resultR >= -1.1);
});

test('no touch within provided candles → EXPIRED (marked to last close)', () => {
  const future = [c(0, 1.09950, 1.09960, 1.09930, 1.09945), c(1, 1.09945, 1.09955, 1.09935, 1.09950)];
  const o = simulateOutcome(sellPlan, future, {});
  assert.equal(o.status, 'EXPIRED');
});

test('spread and slippage reduce the net result', () => {
  const future = [c(0, 1.09950, 1.09960, 1.09760, 1.09780)]; // hits target
  const clean = simulateOutcome(sellPlan, future, {});
  const costed = simulateOutcome(sellPlan, future, { spread: 0.0001, slippage: 0.0001 });
  assert.ok(costed.resultR < clean.resultR);
});

// ── Metrics ─────────────────────────────────────────────────────────────────
function outcome(status, r, extra) {
  return Object.assign({ status, resultR: r, holdingMs: 3 * M15_MS, entryMs: T0 }, extra || {});
}

test('computeMetrics: win rate, profit factor, drawdown, streaks', () => {
  const outs = [outcome('WIN', 2), outcome('WIN', 2), outcome('LOSS', -1), outcome('LOSS', -1), outcome('WIN', 2)];
  const m = computeMetrics(outs);
  assert.equal(m.count, 5);
  assert.equal(m.wins, 3);
  assert.equal(m.winRate, 0.6);
  assert.equal(m.netR, 4);
  assert.equal(m.avgR, 0.8);
  assert.equal(m.profitFactor, 3);        // 6 / 2
  assert.equal(m.maxConsecWins, 2);
  assert.equal(m.maxConsecLosses, 2);
  assert.equal(m.maxDrawdownR, 2);        // after 2 wins (+4), two losses (-2)
});

test('groupBy variant separates the four setup-direction combinations', () => {
  const outs = [
    outcome('WIN', 2, { setupType: 'IMMEDIATE', failedSide: 'BUYERS' }),
    outcome('LOSS', -1, { setupType: 'DELAYED', failedSide: 'BUYERS' }),
    outcome('WIN', 2, { setupType: 'IMMEDIATE', failedSide: 'SELLERS' }),
    outcome('WIN', 2, { setupType: 'DELAYED', failedSide: 'SELLERS' }),
  ];
  const g = groupBy(outs, variantKey);
  assert.deepEqual(Object.keys(g).sort(), ['DELAYED_BUYERS', 'DELAYED_SELLERS', 'IMMEDIATE_BUYERS', 'IMMEDIATE_SELLERS']);
  assert.equal(g.IMMEDIATE_BUYERS.count, 1);
});

test('stabilityFlags catches pair dominance and small samples', () => {
  const outs = [outcome('WIN', 10, { pair: 'EUR_USD', setupType: 'IMMEDIATE', failedSide: 'BUYERS' }),
    outcome('WIN', 0.1, { pair: 'GBP_USD', setupType: 'IMMEDIATE', failedSide: 'BUYERS' })];
  const flags = stabilityFlags(outs);
  assert.ok(flags.some((f) => f.type === 'PAIR_DOMINANCE' && f.pair === 'EUR_USD'));
  assert.ok(flags.some((f) => f.type === 'SMALL_SAMPLE'));
});

test('compareConfirmation isolates sweep / h1 / full stages', () => {
  const recs = [
    { mode: 'sweep', status: 'LOSS', resultR: -1, holdingMs: 0 },
    { mode: 'h1', status: 'WIN', resultR: 1, holdingMs: 0 },
    { mode: 'full', status: 'WIN', resultR: 2, holdingMs: 0 },
  ];
  const cmp = compareConfirmation(recs);
  assert.equal(cmp.sweepAlone.netR, -1);
  assert.equal(cmp.fullH1M15.netR, 2);
});

// ── Backfill ────────────────────────────────────────────────────────────────
// Fake evaluator: emits one confirmed signal at a fixed step, empty otherwise.
function fakeEvaluate(pair, evalMs) {
  const empty = { confirmed: [], watch: [], pendingDelayed: [], pendingM15: [], accepted: [], expiredInvalidated: [] };
  if (pair === 'EUR_USD' && evalMs === cMs(2)) {
    return Promise.resolve(Object.assign({}, empty, {
      confirmed: [{
        eventKey: 'EUR_USD:SELL:L:F', signalKey: 'EUR_USD:SELL:L:F', pair: 'EUR_USD', direction: 'SELL',
        setupType: 'IMMEDIATE', score: { total: 88 },
        event: { eventKey: 'EUR_USD:SELL:L:F', pair: 'EUR_USD', state: 'FAILURE_CONFIRMED', transitions: [{ signalKey: 'EUR_USD:SELL:L:F', toState: 'FAILURE_CONFIRMED', occurredAt: '2026-08-03T00:30:00Z', idempotencyKey: 'k1' }] },
      }],
    }));
  }
  return Promise.resolve(empty);
}

test('backfill persists idempotently and never duplicates on re-run', async () => {
  const store = createMemoryStore();
  const base = { evaluate: fakeEvaluate, store, from: cMs(0), to: cMs(4), pairs: ['EUR_USD', 'GBP_USD'] };

  const first = await runBackfill(base);
  assert.equal(first.done, true);
  assert.equal(first.created.signals, 1);
  assert.equal(first.created.events, 1);
  assert.equal(first.created.transitions, 1);

  const second = await runBackfill(base);       // same window, same store
  assert.equal(second.created.signals, 0);      // nothing new
  assert.equal(second.dupes.signals, 1);
  assert.equal(store.counts().signals, 1);
});

test('backfill checkpoints and resumes without gaps or duplicates', async () => {
  const store = createMemoryStore();
  const part1 = await runBackfill({ evaluate: fakeEvaluate, store, from: cMs(0), to: cMs(4), pairs: ['EUR_USD'], maxSteps: 2 });
  assert.equal(part1.done, false);
  assert.ok(part1.checkpoint.nextMs === cMs(2));

  const part2 = await runBackfill({ evaluate: fakeEvaluate, store, to: cMs(4), pairs: ['EUR_USD'], checkpoint: part1.checkpoint });
  assert.equal(part2.done, true);
  assert.equal(store.counts().signals, 1);       // the step-2 signal captured exactly once
});

test('dry-run reports counts without writing', async () => {
  const store = createMemoryStore();
  const r = await runBackfill({ evaluate: fakeEvaluate, store, from: cMs(0), to: cMs(4), pairs: ['EUR_USD'], dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(r.created.signals >= 1);
  assert.equal(store.counts().signals, 0);       // nothing persisted
});
