'use strict';

/**
 * Phase 5 validation (spec §9, §14): persistence is idempotent and the SAME engine produces
 * the SAME trades historically and live.
 *   - deterministic signal ids (uuid v5 of the dedup key),
 *   - the store de-duplicates within a run and the terminal skip-set suppresses re-processing,
 *   - a fake Supabase honouring ON CONFLICT DO NOTHING / upsert → re-running a window neither
 *     duplicates immutable signals/events nor loses the mutable outcome advance,
 *   - historical vs forward runs over identical data yield identical trades (origin aside).
 */

const test = require('node:test');
const assert = require('node:assert');

const { supabaseStore, uuidv5 } = require('../../research/signals/store');
const { runStrategy, memFine, memStore } = require('../../src/signalEngine');
const { strategyDef } = require('../../research/signals/config');
const { genFiring } = require('./fixtures');

const def = strategyDef('today');

// ── A minimal in-memory Supabase double honouring the store's conflict semantics ──
function fakeSb() {
  const tables = { signals: new Map(), signal_events: new Map(), trade_outcomes: new Map(), signal_engine_cursor: new Map() };
  function keyOf(table, row) {
    if (table === 'signals') return row.id;
    if (table === 'signal_events') return [row.signal_id, row.event_type, row.at_ms].join('|');
    if (table === 'trade_outcomes') return row.signal_id;
    if (table === 'signal_engine_cursor') return row.strategy_key;
    return JSON.stringify(row);
  }
  return {
    _tables: tables,
    from(table) {
      const t = tables[table];
      return {
        async upsert(rows, opts = {}) {
          for (const row of rows) {
            const k = keyOf(table, row);
            if (t.has(k) && opts.ignoreDuplicates) continue;   // ON CONFLICT DO NOTHING
            t.set(k, Object.assign({}, t.get(k), row));         // insert or merge-update
          }
          return { error: null };
        },
        select() {
          const api = { _rows: Array.from(t.values()), in(_c, _v) { return api; }, eq(_c, _v) { return api; }, limit() { return Promise.resolve({ data: api._rows, error: null }); } };
          // make it awaitable for loadTerminal (no .limit())
          api.then = (res) => res({ data: api._rows, error: null });
          return api;
        },
      };
    },
  };
}

test('uuidv5 is deterministic per dedup key and distinct across keys', () => {
  const a = uuidv5('today|tsf-1.0.0|AUD_JPY|123');
  const b = uuidv5('today|tsf-1.0.0|AUD_JPY|123');
  const c = uuidv5('today|tsf-1.0.0|AUD_JPY|456');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('store de-duplicates puts within a run and the terminal set suppresses has()', () => {
  const id = uuidv5('today|tsf-1.0.0|EUR_USD|999');
  const store = supabaseStore(null, { terminalIds: new Set([id]) });
  assert.equal(store.has('today|tsf-1.0.0|EUR_USD|999'), true);       // already resolved → skip
  assert.equal(store.has('today|tsf-1.0.0|EUR_USD|111'), false);
  const sig = { strategyKey: 'today', version: 'tsf-1.0.0', pair: 'GBP_USD', entryCloseMs: 7 };
  store.put('today|tsf-1.0.0|GBP_USD|7', sig, { status: 'EXPIRED', events: [] });
  store.put('today|tsf-1.0.0|GBP_USD|7', sig, { status: 'EXPIRED', events: [] });
  assert.equal(store.buffered(), 1, 'same key buffered once');
});

test('re-running a window is idempotent (no duplicate signals/events; outcome advances)', async () => {
  const { baseByPair, monByPair, lastDataMs } = genFiring();
  const getFine = memFine(monByPair);
  const sb = fakeSb();

  // First persisted run.
  const s1 = supabaseStore(sb, { terminalIds: new Set() });
  const r1 = await runStrategy(def, baseByPair, getFine, lastDataMs, s1, 'forward', {});
  const w1 = await s1.flush();
  assert.ok(r1.ok && r1.trades.length >= 1);
  const sigCount1 = sb._tables.signals.size;
  const evCount1 = sb._tables.signal_events.size;
  assert.equal(sigCount1, w1.signals);

  // Second identical run with NO terminal skip → same keys re-buffered, but conflict-ignored.
  const s2 = supabaseStore(sb, { terminalIds: new Set() });
  await runStrategy(def, baseByPair, getFine, lastDataMs, s2, 'forward', {});
  await s2.flush();
  assert.equal(sb._tables.signals.size, sigCount1, 'no duplicate immutable signals');
  assert.equal(sb._tables.signal_events.size, evCount1, 'no duplicate events');
});

test('historical and live (forward) runs produce identical trades (origin aside)', async () => {
  const { baseByPair, monByPair, lastDataMs } = genFiring();
  const hist = await runStrategy(def, baseByPair, memFine(monByPair), lastDataMs, memStore(), 'historical', {});
  const live = await runStrategy(def, baseByPair, memFine(monByPair), lastDataMs, memStore(), 'forward', {});
  const digest = (r) => r.trades.map((t) => [t.signal.pair, t.signal.direction, t.signal.entryCloseMs, t.status, t.exitReason, t.netR == null ? null : +t.netR.toFixed(6)]);
  assert.deepEqual(digest(hist), digest(live), 'one engine → identical historical/live outcomes');
  assert.ok(hist.trades.some((t) => t.signal.pair === 'AUD_JPY'));
});
