'use strict';

// NervaFX H1 Continuation Engine — scanner + persistence integration tests.
// Uses an in-memory mock Supabase client (no network). Run with:
//   node --test tests/h1c

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanAll } = require('../../api/_h1c-scan');
const { persistScan } = require('../../api/_h1c-persist');
const { PAIRS } = require('../../api/_h1c-constants');

const HOUR = 3600000;
const EVAL = Date.UTC(2026, 5, 1, 0, 0, 0);
const BASE = EVAL - 200 * HOUR;   // enough room for 160+ closed candles.

// 160 flat H1 candles → no impulse → SEARCHING (but successfully evaluated).
function flatSeries() {
  const rows = [];
  for (let i = 0; i < 160; i++) {
    rows.push({ time: new Date(BASE + i * HOUR).toISOString(), open: 1.0, high: 1.0002, low: 0.9998, close: 1.0, complete: true });
  }
  return rows;
}
// A full BUY setup that stalls into CONTINUATION_READY.
function readySeries() {
  const rows = flatSeries();
  const imp = [
    [1.0000, 1.0010, 1.0000, 1.0010], [1.0010, 1.0020, 1.0010, 1.0020], [1.0020, 1.0030, 1.0020, 1.0030],
    [1.0030, 1.0030, 1.0024, 1.0025], [1.0025, 1.0025, 1.0019, 1.0020], [1.0020, 1.0020, 1.0014, 1.0015],
    [1.0015, 1.0015, 1.0011, 1.0012], [1.0012, 1.0013, 1.0010, 1.0011], [1.0011, 1.0013, 1.0010, 1.0012],
  ];
  imp.forEach((r, k) => rows.push({ time: new Date(BASE + (160 + k) * HOUR).toISOString(), open: r[0], high: r[1], low: r[2], close: r[3], complete: true }));
  return rows;
}

// Minimal in-memory mock of the Supabase client used by the engine.
function makeMock(store, opts = {}) {
  const state = { setups: {}, history: [], requested: { timeframes: new Set(), instruments: [] } };
  return {
    _state: state,
    from(table) {
      if (table === 'backtest_candles') {
        const q = {};
        const b = {
          select() { return b; },
          eq(col, val) { q[col] = val; if (col === 'timeframe') state.requested.timeframes.add(val); return b; },
          lte(col, val) { q['lte_' + col] = val; return b; },
          order() { return b; },
          limit(n) { q.limit = n; return b; },
          then(res) {
            state.requested.instruments.push(q.instrument);
            if (opts.failFor && opts.failFor.includes(q.instrument)) return res({ data: null, error: { message: 'mock fetch fail' } });
            let rows = (store[q.instrument] || []).slice();
            const until = q.lte_time;
            if (until) rows = rows.filter((r) => new Date(r.time).getTime() <= new Date(until).getTime());
            rows.sort((a, z) => new Date(z.time) - new Date(a.time));
            if (q.limit) rows = rows.slice(0, q.limit);
            res({ data: rows, error: null });
          },
        };
        return b;
      }
      if (table === 'h1_continuation_setups') {
        return { upsert(row) { state.setups[row.setup_id] = row; return { then: (res) => res({ error: null }) }; } };
      }
      // h1_continuation_history
      const q = {};
      const b = {
        select() { return b; },
        eq(col, val) { q[col] = val; return b; },
        order() { return b; },
        limit(n) { q.limit = n; return b; },
        then(res) {
          const rows = state.history.filter((h) => h.setup_id === q.setup_id).sort((a, z) => new Date(z.at) - new Date(a.at));
          res({ data: rows.slice(0, q.limit || rows.length), error: null });
        },
        insert(row) { state.history.push(row); return { then: (res) => res({ error: null }) }; },
      };
      return b;
    },
  };
}

function allFlatStore() {
  const store = {};
  for (const p of PAIRS) store[p] = flatSeries();
  return store;
}

test('scans all 28 pairs with one shared evaluation timestamp', async () => {
  const mock = makeMock(allFlatStore());
  const scan = await scanAll(mock, { evalMs: EVAL });
  assert.equal(scan.pairs.length, 28);
  assert.equal(scan.pairsRequested, 28);
  assert.equal(scan.evaluated, 28);
  assert.equal(scan.dataErrors, 0);
  assert.equal(scan.timeframe, 'H1');
  for (const p of scan.pairs) {
    if (p.setup) assert.equal(p.setup.timestamps.evaluatedAt, scan.generatedAt);
  }
});

test('only H1 (no lower-timeframe) data is requested', async () => {
  const mock = makeMock(allFlatStore());
  await scanAll(mock, { evalMs: EVAL });
  assert.deepEqual([...mock._state.requested.timeframes], ['H1']);
});

test('one pair data failure does not stop the other 27', async () => {
  const mock = makeMock(allFlatStore(), { failFor: ['EUR_USD'] });
  const scan = await scanAll(mock, { evalMs: EVAL });
  assert.equal(scan.dataErrors, 1);
  assert.equal(scan.evaluated, 27);
  const eu = scan.pairs.find((p) => p.instrument === 'EUR_USD');
  assert.equal(eu.dataQuality.ok, false);
});

test('independent pair states + a READY setup surfaces and ranks', async () => {
  const store = allFlatStore();
  store['EUR_USD'] = readySeries();
  const scan = await scanAll(makeMock(store), { evalMs: EVAL });
  const eu = scan.pairs.find((p) => p.instrument === 'EUR_USD');
  const gu = scan.pairs.find((p) => p.instrument === 'GBP_USD');
  assert.equal(eu.setup.state, 'CONTINUATION_READY');
  assert.equal(gu.setup.state, 'SEARCHING');
  assert.equal(scan.setups[0].instrument, 'EUR_USD');   // READY ranks above SEARCHING (which is excluded)
});

test('stable setup id is deterministic across identical scans', async () => {
  const store = allFlatStore(); store['EUR_USD'] = readySeries();
  const a = await scanAll(makeMock(store), { evalMs: EVAL });
  const b = await scanAll(makeMock(store), { evalMs: EVAL });
  const idA = a.pairs.find((p) => p.instrument === 'EUR_USD').setup.setupId;
  const idB = b.pairs.find((p) => p.instrument === 'EUR_USD').setup.setupId;
  assert.equal(idA, idB);
  assert.match(idA, /^EUR_USD:BUY:/);
});

test('persistence is idempotent and appends history only on change', async () => {
  const store = allFlatStore(); store['EUR_USD'] = readySeries();
  const mock = makeMock(store);
  const scan = await scanAll(mock, { evalMs: EVAL });
  const first = await persistScan(mock, scan);
  assert.equal(first.persisted, true);
  assert.ok(first.transitionsAppended >= 1);
  const second = await persistScan(mock, scan);      // same evaluation repeated
  assert.equal(second.persisted, true);
  assert.equal(second.transitionsAppended, 0);       // no duplicate transitions
});
