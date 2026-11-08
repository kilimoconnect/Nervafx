'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { evaluateStrategy, STATUS } = require('../../research/signals/evaluate');
const { strategyDef, TF_MS } = require('../../research/signals/config');
const { genBase, scaledGrowth } = require('./fixtures');

const M15 = TF_MS.M15, DAY = TF_MS.D1;
const def = strategyDef('today');

// Two days of M15 from 2025-05-01; evaluate at day 2, 06:00 (history exists before baseline).
const START = Date.UTC(2025, 4, 1, 0, 0, 0);
const ASOF = Date.UTC(2025, 4, 2, 6, 0, 0);

function digest(r) {
  return {
    ok: r.ok,
    baselineMs: r.baselineMs,
    ranks: r.ranking.map((x) => [x.pair, x.rank, x.bias, round(x.differential)]),
    shortlist: r.shortlist.map((x) => [x.pair, x.rank, x.status]),
    signals: r.signals.map((s) => [s.pair, s.direction, s.entryCloseMs, round(s.referenceEntry)]),
  };
}
function round(x) { return x == null ? null : Math.round(x * 1e9) / 1e9; }

test('prefix-invariance: decisions through asOf identical with or without future data', () => {
  const nFull = Math.ceil((ASOF - START) / M15) + 4 * 96;    // well past asOf
  const full = genBase(scaledGrowth(0.0003), START, nFull, M15);
  // truncated copy: only candles with close <= asOf
  const prefix = {}; for (const p of Object.keys(full)) prefix[p] = full[p].filter((c) => c.openMs + M15 <= ASOF);

  const rFull = evaluateStrategy(def, ASOF, full);
  const rPrefix = evaluateStrategy(def, ASOF, prefix);
  assert.deepEqual(digest(rFull), digest(rPrefix), 'future candles must not change decisions through asOf');
});

test('shortlist is exactly the top-3 by rank; no 4th-pair substitution', () => {
  const nFull = Math.ceil((ASOF - START) / M15) + 10;
  const full = genBase(scaledGrowth(0.0003), START, nFull, M15);
  const r = evaluateStrategy(def, ASOF, full);
  assert.ok(r.ok);
  assert.equal(r.shortlist.length, 3);
  assert.deepEqual(r.shortlist.map((x) => x.rank), [1, 2, 3]);
  assert.equal(r.shortlist[0].pair, 'AUD_JPY');
});

test('monotone fixture: confirmation passes but flat entry candles leave status at waiting-for-trigger', () => {
  const nFull = Math.ceil((ASOF - START) / M15) + 10;
  const full = genBase(scaledGrowth(0.0003), START, nFull, M15);
  const r = evaluateStrategy(def, ASOF, full);
  assert.equal(r.signals.length, 0, 'no signal from flat (no-pattern) entry candles');
  for (const row of r.shortlist) {
    assert.equal(row.status, STATUS.WAIT_TRIGGER, row.pair + ' reached confirmation, awaits trigger');
    assert.ok(row.confirmation.pass, row.pair + ' confirmation passed');
  }
});

test('replay cut: evaluating earlier hides later candles (baseline + ranking shift)', () => {
  const nFull = Math.ceil((ASOF - START) / M15) + 10;
  const full = genBase(scaledGrowth(0.0003), START, nFull, M15);
  const earlier = Date.UTC(2025, 4, 1, 12, 0, 0);           // day 1 noon
  const r = evaluateStrategy(def, earlier, full);
  assert.ok(r.ok);
  assert.equal(r.baselineMs, Date.UTC(2025, 4, 1, 0, 0, 0), 'baseline = day-1 start');
  // confirmation interval end never exceeds asOf
  assert.ok(r.confirmInterval.endMs <= earlier);
});
