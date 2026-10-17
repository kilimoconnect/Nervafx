'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { M15, PAIRS, frameOpenForClose, eatToUtc, syncAsOf, replay, integrityReport, loadAllPairsFromDb } = require('../../research/m15/loader');

const open = (h, m, d = 10) => Date.UTC(2026, 8, d, h, m, 0);            // Sep 2026 UTC
const T = Date.UTC(2026, 8, 10, 12, 0, 0);                                // 15:00 EAT boundary
const mk = (openMs, src = 'OANDA') => ({ openMs, time: new Date(openMs).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1001, volume: 100, complete: true, source: src });

function fullHist(openMsList, src) { const h = {}; for (const p of PAIRS) h[p] = openMsList.map((o) => mk(o, src)); return h; }

test('UTC/EAT: 15:00 EAT parses to 12:00 UTC', () => {
  assert.equal(eatToUtc('2026-09-10', '15:00'), T);
  assert.equal(new Date(T).toISOString(), '2026-09-10T12:00:00.000Z');
});

test('NO LOOK-AHEAD boundary: 14:00 EAT candle included, 15:00 EAT excluded at T=15:00 EAT', () => {
  const hist = fullHist([open(9, 0), open(10, 0), open(11, 0), open(12, 0), open(13, 0)]);
  const v = syncAsOf(hist, T);
  assert.equal(v.frameOpenMs, open(11, 0));                              // last eligible = 11:45 (closes 12:00)
  for (const p of PAIRS) for (const c of v.bySync[p]) {
    assert.ok(c.openMs + M15 <= T, `${p} candle opening ${new Date(c.openMs).toISOString()} closes after T`);
  }
  const last = v.bySync['EUR_USD'].slice(-1)[0];
  assert.equal(last.openMs, open(11, 0));
});

test('frameOpenForClose: T on grid ⇒ T − 1h (the candle that closed at T)', () => {
  assert.equal(frameOpenForClose(T), open(11, 0));
  assert.equal(frameOpenForClose(open(13, 0)), open(12, 0));
});

test('missing pair ⇒ reported, not fabricated; not aligned', () => {
  const hist = fullHist([open(11, 0)]); delete hist['CHF_JPY'];
  const v = syncAsOf(hist, T);
  assert.ok(v.missing.includes('CHF_JPY'));
  assert.equal(v.aligned, false);
});

test('a laggard pair collapses the common frame; no pair sees beyond it', () => {
  const hist = fullHist([open(10, 0), open(11, 0)]);
  hist['USD_JPY'] = [mk(open(10, 0))];                                   // one candle behind
  const v = syncAsOf(hist, T);
  assert.equal(v.frameOpenMs, open(10, 0));                             // common min
  assert.ok(v.laggards.length === 0 ? false : true);
  for (const p of PAIRS) assert.ok(v.bySync[p].every((c) => c.openMs <= open(10, 0)));
});

test('deterministic: identical histories ⇒ identical as-of view', () => {
  const a = syncAsOf(fullHist([open(10, 0), open(11, 0)]), T);
  const b = syncAsOf(fullHist([open(10, 0), open(11, 0)]), T);
  assert.equal(a.frameOpenMs, b.frameOpenMs);
  assert.deepEqual(a.bySync['EUR_USD'].map((c) => c.openMs), b.bySync['EUR_USD'].map((c) => c.openMs));
});

test('source consistency: mixed sources are flagged', () => {
  const hist = fullHist([open(10, 0), open(11, 0)], 'OANDA');
  hist['EUR_USD'] = [mk(open(10, 0), 'OANDA'), mk(open(11, 0), 'OTHER')];
  const rep = integrityReport(hist);
  assert.equal(rep.singleSource, false);
  assert.ok(rep.sources.includes('OTHER'));
});

test('replay: chronological, no look-ahead per close, deterministic count', () => {
  const opens = [];
  for (let i = 0; i < 10; i++) opens.push(open(10, 0) + i * M15);         // 10 consecutive candles
  const hist = fullHist(opens);
  const frames = [];
  const r = replay(hist, { fromCloseMs: open(11, 0), toCloseMs: open(15, 0), onClose: (t, v) => { assert.ok(v.frameOpenMs + M15 <= t); frames.push(v.frameOpenMs); } });
  assert.ok(r.processed > 0);
  // strictly increasing frames (chronological, one per close)
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i] > frames[i - 1]);
});

// no-production-writes: loadAllPairsFromDb must use SELECT only — a stub that
// throws on any write method proves it never writes.
function readOnlyStub(rows) {
  const writes = ['insert', 'update', 'delete', 'upsert', 'rpc'];
  const qb = () => {
    const st = {};
    const b = new Proxy({}, { get(_, prop) {
      if (writes.includes(prop)) return () => { throw new Error(`WRITE ATTEMPTED: ${prop}`); };
      if (prop === 'then') return (resolve) => resolve({ data: rows, error: null });
      return () => b;
    } });
    return b;
  };
  return { from() { return qb(); } };
}

test('loadAllPairsFromDb performs NO writes (select-only)', async () => {
  const sb = readOnlyStub([]);           // returns empty page ⇒ loop exits immediately
  const out = await loadAllPairsFromDb(sb, { pairs: ['EUR_USD'] });
  assert.deepEqual(out['EUR_USD'], []);  // completed with zero writes (stub would have thrown)
});

test('AUDIT 5A regression: gap/weekend T-steps are stale re-evals (guard: frameOpen+1h === close)', () => {
  const F = Date.UTC(2026, 8, 4, 20, 0, 0);          // Fri 20:30 open (closes F+15)
  const Mon = Date.UTC(2026, 8, 7, 0, 0, 0);          // Mon 00:00 open — weekend gap
  const hist = {}; for (const p of PAIRS) hist[p] = [
    { openMs: F - M15, close: 1.1, high: 1.1, low: 1.1, open: 1.1, complete: true, source: 'OANDA' },
    { openMs: F, close: 1.1, high: 1.1, low: 1.1, open: 1.1, complete: true, source: 'OANDA' },
    { openMs: Mon, close: 1.1, high: 1.1, low: 1.1, open: 1.1, complete: true, source: 'OANDA' },
  ];
  assert.equal(syncAsOf(hist, F + M15).frameOpenMs + M15, F + M15);   // evaluated at its own close only
  let total = 0, stale = 0;
  for (let T = F + 2 * M15; T < Mon; T += M15) { const v = syncAsOf(hist, T); if (v.frameOpenMs == null) continue; total++; if (v.frameOpenMs + M15 !== T) stale++; }
  assert.ok(total > 20);                             // ~2 days of weekend hourly steps
  assert.equal(stale, total);                         // ALL weekend steps are stale re-evals (now skipped by the guard)
});
