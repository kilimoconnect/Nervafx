'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  zonedWallToUtcMs, snapToH1, isHistoricalRequest, prevH1, nextH1, nextH1Allowed,
  localDayBoundsUtc,
} = require('../../api/_h1c-time');
const { sanitizeH1 } = require('../../api/_h1c-data');
const { evaluateSetup } = require('../../api/_h1c-state');
const { replayDay } = require('../../api/_h1c-history');
const { STATE_LIST } = require('../../api/_h1c-constants');

const HOUR = 60 * 60 * 1000;
const iso = (s) => new Date(s).getTime();

// ── Feature 1/10 — timezone conversion & snapping ───────────────────────────
test('14 Aug 2026 10:00 Africa/Dar_es_Salaam → 2026-08-14T07:00:00.000Z', () => {
  assert.equal(zonedWallToUtcMs(2026, 8, 14, 10, 0, 'Africa/Dar_es_Salaam'), iso('2026-08-14T07:00:00Z'));
});

test('10:37 EAT snaps to the 10:00 EAT H1 close (07:00 UTC)', () => {
  const raw = zonedWallToUtcMs(2026, 8, 14, 10, 37, 'Africa/Dar_es_Salaam');
  assert.equal(snapToH1(raw), iso('2026-08-14T07:00:00Z'));
});

test('timezone conversion is DST-independent for EAT (fixed +3, no DST)', () => {
  assert.equal(zonedWallToUtcMs(2026, 1, 14, 10, 0, 'Africa/Dar_es_Salaam'), iso('2026-01-14T07:00:00Z'));
});

test('localDayBoundsUtc maps an EAT calendar day to the right UTC window', () => {
  const { startMs, endMs } = localDayBoundsUtc('2026-08-14', 'Africa/Dar_es_Salaam');
  assert.equal(startMs, iso('2026-08-13T21:00:00Z')); // 14 Aug 00:00 EAT = 13 Aug 21:00 UTC
  assert.equal(endMs, iso('2026-08-14T21:00:00Z'));
});

// ── Feature 5 — navigation maths ────────────────────────────────────────────
test('prev/next H1 move exactly one boundary', () => {
  const at = iso('2026-08-14T07:00:00Z');
  assert.equal(prevH1(at), iso('2026-08-14T06:00:00Z'));
  assert.equal(nextH1(at), iso('2026-08-14T08:00:00Z'));
  assert.equal(nextH1(iso('2026-08-14T07:37:00Z')), iso('2026-08-14T08:00:00Z')); // snaps first
});

test('Next H1 cannot move past the latest completed candle', () => {
  const latestClose = iso('2026-08-14T08:00:00Z');
  assert.equal(nextH1Allowed(iso('2026-08-14T07:00:00Z'), latestClose), true);  // → 08:00 == latest, ok
  assert.equal(nextH1Allowed(iso('2026-08-14T08:00:00Z'), latestClose), false); // → 09:00 > latest
  assert.equal(nextH1Allowed(iso('2026-08-14T08:00:00Z'), null), true);         // unknown bound → allowed
});

// ── Feature 3 — historical request predicate (drives read-only gating) ──────
test('isHistoricalRequest distinguishes live from historical', () => {
  assert.equal(isHistoricalRequest({}), false);
  assert.equal(isHistoricalRequest({ debug: '1' }), false);
  assert.equal(isHistoricalRequest({ at: '2026-08-14T07:00:00Z' }), true);
});

// ── Feature 2 — strict no-lookahead via the SAME sanitizer ──────────────────
function series(startMs, specs) {
  return specs.map((s, i) => ({ time: new Date(startMs + i * HOUR).toISOString(), open: s.o, high: s.h, low: s.l, close: s.c }));
}
function flat(n, startMs, price) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: new Date(startMs + i * HOUR).toISOString(), open: price, high: price + 0.0001, low: price - 0.0001, close: price });
  return out;
}

test('no candle closing after the evaluation time is used; forming candle excluded', () => {
  const base = iso('2026-08-14T00:00:00Z');
  // candle open 06:00 closes 07:00; open 07:00 (forming at 07:00) closes 08:00
  const rows = flat(200, base - 200 * HOUR, 1.1).concat([
    { time: new Date(base + 6 * HOUR).toISOString(), open: 1.1, high: 1.1001, low: 1.0999, close: 1.1 },
    { time: new Date(base + 7 * HOUR).toISOString(), open: 1.1, high: 1.1001, low: 1.0999, close: 1.1 },
  ]);
  const evalMs = base + 7 * HOUR; // 07:00
  const san = sanitizeH1(rows, evalMs);
  assert.equal(san.ok, true);
  for (const c of san.candles) assert.ok(c.ms + HOUR <= evalMs, 'every candle closed by evalMs');
  // the 07:00-open candle (closes 08:00) must be absent
  assert.ok(!san.candles.some((c) => c.ms === base + 7 * HOUR));
  assert.ok(san.candles.some((c) => c.ms === base + 6 * HOUR)); // 06:00 (closes 07:00) present
});

// ── Determinism / golden reproducibility ────────────────────────────────────
function impulsePairRows(dayStart) {
  // 200 flat candles before the day, then a clean 4-candle up-impulse + pullback
  // starting 5h into the day, then flat — enough to move the state across hours.
  const startMs = dayStart - 200 * HOUR;
  const rows = flat(205, startMs, 1.10000); // …up to dayStart+5h
  const impulse = series(dayStart + 5 * HOUR, [
    { o: 1.10000, h: 1.10160, l: 1.10000, c: 1.10150 },
    { o: 1.10150, h: 1.10310, l: 1.10150, c: 1.10300 },
    { o: 1.10300, h: 1.10460, l: 1.10300, c: 1.10450 },
    { o: 1.10450, h: 1.10610, l: 1.10450, c: 1.10600 },
    { o: 1.10600, h: 1.10605, l: 1.10520, c: 1.10540 }, // pullback 1
    { o: 1.10540, h: 1.10545, l: 1.10470, c: 1.10495 }, // pullback 2
    { o: 1.10495, h: 1.10500, l: 1.10440, c: 1.10470 }, // pullback 3
    { o: 1.10470, h: 1.10475, l: 1.10420, c: 1.10455 }, // pullback 4
  ]);
  return rows.concat(impulse);
}

test('evaluateSetup is reproducible for a fixed series (golden)', () => {
  const rows = impulsePairRows(iso('2026-08-14T00:00:00Z'));
  const san = sanitizeH1(rows, iso('2026-08-14T00:00:00Z') + 9 * HOUR); // through the impulse
  assert.equal(san.ok, true);
  const a = evaluateSetup(san.candles, {});
  const b = evaluateSetup(san.candles, {});
  assert.deepEqual(a, b);
  assert.ok(STATE_LIST.indexOf(a.state) !== -1);
  assert.notEqual(a.state, 'SEARCHING'); // the clean impulse produces a real state
});

// ── Feature 6/11 — full-day replay: deterministic, transitions, isolation ───
test('full-day replay is deterministic, finds transitions, isolates pair failures', async () => {
  const dayStart = iso('2026-08-14T00:00:00Z');
  const latestCloseMs = dayStart + 23 * HOUR; // evaluate 00:00..23:00 → 24 hours
  const fetchPairRows = (inst) => {
    if (inst === 'EUR_USD') return Promise.resolve(impulsePairRows(dayStart));
    if (inst === 'GBP_USD') return Promise.reject(new Error('boom'));           // isolation
    if (inst === 'AUD_USD') return Promise.resolve(flat(50, dayStart - 50 * HOUR, 1.2)); // < 150 → warning
    return Promise.resolve(flat(220, dayStart - 200 * HOUR, 1.3));              // valid, no setup
  };
  const opts = { date: '2026-08-14', timezone: 'UTC', latestCloseMs, fetchPairRows };

  const r1 = await replayDay(null, opts);
  const r2 = await replayDay(null, opts);
  assert.deepEqual(r1, r2);                                   // deterministic (same timestamp+config)
  assert.equal(r1.hourlySummaries.length, 24);
  assert.ok(r1.transitions.length >= 1, 'the impulse pair changed state across hours');
  assert.ok(r1.transitions.every((t) => t.evaluatedAtUtc && t.toState), 'transitions carry time+state');
  assert.ok(r1.pairErrors.some((e) => e.pair === 'GBP/USD'), 'failing pair isolated to pairErrors');
  assert.ok(r1.dataWarnings.some((w) => w.pair === 'AUD/USD'), 'short-history pair warned');
  // EUR/USD reached a non-SEARCHING state at some hour
  assert.ok(r1.hourlySummaries.some((h) => Object.keys(h.stateCounts).some((s) => s !== 'SEARCHING')));
});
