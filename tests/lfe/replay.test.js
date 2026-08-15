'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveSnapshotTime, evaluatePair } = require('../../api/_lfe-scan');
const { makeMemoryEvaluate } = require('../../api/_lfe-backfill');
const { filterClosedCandles } = require('../../api/_lfe-data');
const { confirmM15 } = require('../../api/_lfe-mss');
const { CONFIG, MSS_STATUS, HOUR_MS, M15_MS } = require('../../api/_lfe-constants');

const iso = (s) => new Date(s).getTime();
const coverage = {
  earliestSelectable: iso('2025-06-01T00:00:00Z'),
  earliestSelectableIso: '2025-06-01T00:00:00.000Z',
  commonEarliestRawIso: '2025-05-19T13:30:00.000Z',
  latestAvailable: iso('2026-08-14T16:00:00Z'),
  commonLatestIso: '2026-08-14T16:00:00.000Z',
};

// ── D. Normalization ────────────────────────────────────────────────────────
test('a 10:37 selection normalizes down to 10:30', () => {
  const r = resolveSnapshotTime({ at: '2026-08-14T10:37:00Z', timezone: 'UTC' }, coverage);
  assert.equal(r.ok, true);
  assert.equal(r.ctx.evaluationTimeUtc, '2026-08-14T10:30:00.000Z');
  assert.equal(r.ctx.requestedTime, '2026-08-14T10:37:00.000Z');
});

test('a selection after commonLatest fails safely with the valid range', () => {
  const r = resolveSnapshotTime({ at: '2027-01-01T00:00:00Z', timezone: 'UTC' }, coverage);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'AFTER_COVERAGE');
  assert.equal(r.error.validRange.latest, coverage.commonLatestIso);
  assert.equal(r.error.validRange.earliest, coverage.earliestSelectableIso);
});

test('different timezones for the same UTC instant give the same evaluation time', () => {
  const ny = resolveSnapshotTime({ at: '2026-08-14T10:37:00Z', timezone: 'America/New_York' }, coverage);
  const tk = resolveSnapshotTime({ at: '2026-08-14T10:37:00Z', timezone: 'Asia/Tokyo' }, coverage);
  assert.equal(ny.ctx.evaluationMs, tk.ctx.evaluationMs);
  assert.equal(ny.ctx.evaluationTimeUtc, tk.ctx.evaluationTimeUtc);
  assert.notEqual(ny.ctx.displayTimezone, tk.ctx.displayTimezone); // display differs, market snapshot does not
});

// ── C. Strict as-of candle bound ────────────────────────────────────────────
test('an H1 candle closing at 11:00 is unavailable at 10:30', () => {
  const rows = [
    { time: '2026-08-14T09:00:00Z', open: 1, high: 1, low: 1, close: 1 }, // closes 10:00
    { time: '2026-08-14T10:00:00Z', open: 1, high: 1, low: 1, close: 1 }, // closes 11:00
  ];
  const kept = filterClosedCandles(rows, iso('2026-08-14T10:30:00Z'), HOUR_MS);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].openMs, iso('2026-08-14T09:00:00Z'));
});

// ── C. Pending stays pending even if later data exists ──────────────────────
test('a pending M15 confirmation at T stays pending even though a later break exists', () => {
  const T0 = Date.UTC(2026, 7, 3, 0, 0, 0);
  const cMs = (idx) => T0 + (idx + 1) * M15_MS;
  const mk = (rows) => rows.map((r, i) => ({ openMs: T0 + i * M15_MS, time: new Date(T0 + i * M15_MS).toISOString(), open: r[0], high: r[1], low: r[2], close: r[3] }));
  const m15 = mk([
    [1.09980, 1.09990, 1.09970, 1.09985],
    [1.09985, 1.09990, 1.09960, 1.09965],
    [1.09965, 1.09975, 1.09950, 1.09970], // pivot low 1.09950
    [1.09970, 1.09995, 1.09965, 1.09990],
    [1.09990, 1.09998, 1.09985, 1.09996],
    [1.09996, 1.10030, 1.09994, 1.10020], // breach
    [1.10020, 1.10025, 1.09930, 1.09940], // the break — exists in the data
  ]);
  const event = { pair: 'EUR_USD', direction: 'SELL', levelCentre: 1.10000, sweepExtreme: 1.10030, h1Atr: 0.0010, breachAtMs: cMs(5), failureAtMs: cMs(5) };

  // Evaluate BEFORE the break candle closes → still waiting, despite the row existing.
  const before = confirmM15(event, m15, null, { evalMs: cMs(5), m15AtrNow: 0.0004 });
  assert.equal(before.status, MSS_STATUS.WAITING);

  // Evaluate at the break candle close → confirmed.
  const after = confirmM15(event, m15, null, { evalMs: cMs(6), m15AtrNow: 0.0004 });
  assert.equal(after.status, MSS_STATUS.CONFIRMED);
});

// ── G. Determinism ──────────────────────────────────────────────────────────
function h1Fixture() {
  const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
  const rows = [
    [1.09900, 1.09950, 1.09880, 1.09930], [1.09930, 1.09960, 1.09900, 1.09940],
    [1.09940, 1.09955, 1.09890, 1.09905], [1.09905, 1.09945, 1.09885, 1.09930],
    [1.09930, 1.09950, 1.09895, 1.09915], [1.09915, 1.09948, 1.09890, 1.09925],
    [1.09925, 1.09952, 1.09900, 1.09930], [1.09930, 1.09955, 1.09905, 1.09935],
    [1.09935, 1.09975, 1.09915, 1.09965], [1.09965, 1.09992, 1.09955, 1.09985],
    [1.09985, 1.10000, 1.09950, 1.09960], // idx10 pivot high 1.10000
    [1.09960, 1.09975, 1.09905, 1.09915], [1.09915, 1.09950, 1.09895, 1.09930],
    [1.09930, 1.09955, 1.09900, 1.09925], [1.09925, 1.09950, 1.09895, 1.09915],
    [1.09915, 1.09948, 1.09890, 1.09920], [1.09920, 1.09950, 1.09895, 1.09925],
    [1.09925, 1.09955, 1.09900, 1.09935], [1.09935, 1.09965, 1.09895, 1.09955],
    [1.09955, 1.09995, 1.09950, 1.09990], [1.09990, 1.10030, 1.09950, 1.09960], // idx20 failure
  ];
  return rows.map((r, i) => ({ openMs: T0 + i * HOUR_MS, time: new Date(T0 + i * HOUR_MS).toISOString(), open: r[0], high: r[1], low: r[2], close: r[3] }));
}

const smallCfg = Object.assign({}, CONFIG, { history: Object.assign({}, CONFIG.history, { minH1: 20, minM15: 0 }) });

test('evaluatePair is deterministic and buckets an unconfirmed failure to watch', () => {
  const data = { h1: h1Fixture(), m15: [], d1: [] };
  const evalMs = h1Fixture()[20].openMs + HOUR_MS;
  const a = evaluatePair('EUR_USD', data, evalMs, {}, smallCfg);
  const b = evaluatePair('EUR_USD', data, evalMs, {}, smallCfg);
  assert.deepEqual(a, b);                 // same input ⇒ identical result
  assert.equal(a.error, null);
  assert.equal(a.confirmed.length, 0);    // no M15 data → not tradable
  assert.ok(a.watch.length >= 1);         // event stays visible as a watch candidate
});

test('the in-memory backfill walker matches the per-step evaluation', () => {
  const hist = { EUR_USD: { h1: h1Fixture(), m15: [], d1: [] } };
  const evalMs = h1Fixture()[20].openMs + HOUR_MS;
  const mem = makeMemoryEvaluate(hist, smallCfg);
  const walked = mem('EUR_USD', evalMs);
  const direct = evaluatePair('EUR_USD', { h1: h1Fixture(), m15: [], d1: [] }, evalMs, { rotation: null }, smallCfg);
  assert.deepEqual(walked, direct);       // identical to the DB-fetch path
});

test('the walker slices strictly as-of: the failure candle is invisible before it closes', () => {
  const hist = { EUR_USD: { h1: h1Fixture(), m15: [], d1: [] } };
  const mem = makeMemoryEvaluate(hist, smallCfg);
  const before = mem('EUR_USD', h1Fixture()[20].openMs);        // failure candle not yet closed
  assert.equal(before.watch.length, 0);
  const after = mem('EUR_USD', h1Fixture()[20].openMs + HOUR_MS); // now closed
  assert.ok(after.watch.length >= 1);
});
