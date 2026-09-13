'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { replayFrameOpen, loadSynchronized } = require('../../api/_m15/load');
const { fetchM15, M15_MS } = require('../../api/_m15/data');
const { PAIRS } = require('../../api/_m15/pairs');

// 2026-09-10 15:00 EAT == 12:00 UTC — the spec's explicit boundary.
const T = Date.UTC(2026, 8, 10, 12, 0, 0);
const open = (h, m) => Date.UTC(2026, 8, 10, h, m, 0);

// ── In-memory Supabase stub (only the methods fetchM15 uses) ─────────────────
function makeSb(rows) {
  const qb = () => {
    const st = { inst: null, tf: null, complete: null, until: null, asc: true, lim: 1e9 };
    const b = {
      select() { return b; },
      eq(col, val) { if (col === 'instrument') st.inst = val; if (col === 'timeframe') st.tf = val; if (col === 'complete') st.complete = val; return b; },
      lte(col, val) { if (col === 'time') st.until = val; return b; },
      order(col, o) { st.asc = !!(o && o.ascending); return b; },
      limit(n) { st.lim = n; return b; },
      then(resolve) {
        let d = rows.filter((r) =>
          (st.inst == null || r.instrument === st.inst) &&
          (st.tf == null || r.timeframe === st.tf) &&
          (st.complete == null || r.complete === st.complete) &&
          (st.until == null || new Date(r.time) <= new Date(st.until)));
        d = d.sort((a, c) => st.asc ? new Date(a.time) - new Date(c.time) : new Date(c.time) - new Date(a.time)).slice(0, st.lim);
        resolve({ data: d, error: null });
      },
    };
    return b;
  };
  return { from() { return qb(); } };
}

function rowsForAllPairs(openMsList, opts = {}) {
  const rows = [];
  for (const pair of PAIRS) {
    for (const oms of openMsList) {
      rows.push({ instrument: pair, timeframe: 'M15', time: new Date(oms).toISOString(),
        open: 1.1, high: 1.1005, low: 1.0995, close: 1.1001, volume: 100, complete: opts.complete !== false });
    }
  }
  return rows;
}

test('replayFrameOpen: at T=12:00 UTC the 11:45 candle is the frame; 12:00 excluded', () => {
  assert.equal(replayFrameOpen(T, false), open(11, 45));           // fixed
  assert.equal(replayFrameOpen(T, true), open(12, 0));             // legacy (lookahead)
  assert.equal(replayFrameOpen(T, false) + M15_MS, T);            // frame closes exactly at T
});

test('replayFrameOpen: off-grid requests snap down to the last completed close', () => {
  assert.equal(replayFrameOpen(open(12, 7), false), open(11, 45)); // 12:07 → last close 12:00 → frame 11:45
  assert.equal(replayFrameOpen(open(12, 14) + 59000, false), open(11, 45));
  assert.equal(replayFrameOpen(open(12, 15), false), open(12, 0)); // next grid close
});

test('EAT→UTC: 15:00 EAT parses to 12:00 UTC', () => {
  assert.equal(Date.parse('2026-09-10T15:00:00+03:00'), T);
  assert.equal(new Date(T).toISOString(), '2026-09-10T12:00:00.000Z');
});

test('loadSynchronized replay includes 11:45 and NEVER a candle closing after T', async () => {
  const sb = makeSb(rowsForAllPairs([open(11, 15), open(11, 30), open(11, 45), open(12, 0), open(12, 15)]));
  const { evalMs, candlesByPair } = await loadSynchronized(sb, { atMs: T });
  assert.equal(evalMs, open(11, 45));
  for (const p of PAIRS) {
    const last = candlesByPair[p][candlesByPair[p].length - 1];
    assert.equal(last.openMs, open(11, 45), `${p} frame must be 11:45`);
    for (const c of candlesByPair[p]) {
      assert.ok(c.openMs + M15_MS <= T, `${p} candle opening ${new Date(c.openMs).toISOString()} closes after T`);
    }
  }
});

test('legacyFrame reproduces the pre-fix lookahead (includes the 12:00 candle)', async () => {
  const sb = makeSb(rowsForAllPairs([open(11, 45), open(12, 0), open(12, 15)]));
  const fixed = await loadSynchronized(sb, { atMs: T, legacyFrame: false });
  const legacy = await loadSynchronized(sb, { atMs: T, legacyFrame: true });
  assert.equal(fixed.evalMs, open(11, 45));
  assert.equal(legacy.evalMs, open(12, 0));  // one candle of lookahead
  const lastLegacy = legacy.candlesByPair['EUR_USD'].slice(-1)[0];
  assert.equal(lastLegacy.openMs + M15_MS, open(12, 15)); // closes at 12:15 > T=12:00 — future info
});

test('fetchM15 excludes incomplete candles and never returns time > until', async () => {
  const rows = [
    { instrument: 'EUR_USD', timeframe: 'M15', time: new Date(open(11, 45)).toISOString(), open: 1, high: 1, low: 1, close: 1, volume: 1, complete: true },
    { instrument: 'EUR_USD', timeframe: 'M15', time: new Date(open(12, 0)).toISOString(), open: 1, high: 1, low: 1, close: 1, volume: 1, complete: false }, // forming
  ];
  const got = await fetchM15(makeSb(rows), 'EUR_USD', open(11, 45));
  assert.equal(got.length, 1);
  assert.equal(got[0].openMs, open(11, 45));
});

test('missing pair ⇒ sync reports MISSING_PAIRS (no fabricated frame)', async () => {
  const rows = rowsForAllPairs([open(11, 45)]).filter((r) => r.instrument !== 'CHF_JPY');
  const { sync } = await loadSynchronized(makeSb(rows), { atMs: T });
  assert.equal(sync.reason, 'MISSING_PAIRS');
  assert.ok(sync.missing.includes('CHF_JPY'));
});

test('replay is deterministic: identical inputs ⇒ identical frame', async () => {
  const mk = () => makeSb(rowsForAllPairs([open(11, 30), open(11, 45)]));
  const a = await loadSynchronized(mk(), { atMs: T });
  const b = await loadSynchronized(mk(), { atMs: T });
  assert.deepEqual(a.evalMs, b.evalMs);
  assert.deepEqual(a.candlesByPair['EUR_USD'].map((c) => c.openMs), b.candlesByPair['EUR_USD'].map((c) => c.openMs));
});
