'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../../api/_scs-time');

const H1 = 3600000;
// hourly H1 candles over [startMs, endMs)
function gen(startMs, endMs) {
  const a = [];
  for (let t = startMs; t < endMs; t += H1) a.push({ openMs: t, open: 1.1, high: 1.1005, low: 1.0995, close: 1.1001 });
  return a;
}

test('UTC ↔ New York, summer (EDT) and winter (EST) — 17:00 NY', () => {
  assert.equal(T.zonedWallToUtcMs(2026, 7, 15, 17, 0, 'America/New_York'), Date.UTC(2026, 6, 15, 21, 0)); // EDT = UTC-4
  assert.equal(T.zonedWallToUtcMs(2026, 1, 15, 17, 0, 'America/New_York'), Date.UTC(2026, 0, 15, 22, 0)); // EST = UTC-5
});

test('EAT and UTC display parts', () => {
  const ms = Date.UTC(2026, 6, 15, 12, 0);
  assert.equal(T.partsInTz(ms, 'UTC').hour, 12);
  assert.equal(T.partsInTz(ms, 'Africa/Dar_es_Salaam').hour, 15); // EAT = UTC+3
});

test('DST boundary: session start shifts by exactly one UTC hour across the change', () => {
  // US DST ends 2026-11-01. The 2026-10-30 (Fri) session is EDT; 2026-11-02 (Mon) is EST.
  const friEDT = T.sessionStartUtc(Date.UTC(2026, 9, 30, 22, 0)); // Fri 18:00 NY (EDT)
  const monEST = T.sessionStartUtc(Date.UTC(2026, 10, 2, 23, 0)); // Mon 18:00 NY (EST)
  assert.equal(T.partsInTz(friEDT, 'America/New_York').hour, 17);
  assert.equal(T.partsInTz(monEST, 'America/New_York').hour, 17);
});

test('completed-candle enforcement: the forming candle is excluded', () => {
  const start = Date.UTC(2026, 6, 20, 12, 0);
  const rows = gen(start, start + 5 * H1);          // opens 12:00..16:00
  const evalMs = start + 4 * H1 + 30 * 60000;        // 16:30 → 16:00 candle still forming
  const norm = T.normalizeH1(rows, evalMs);
  assert.equal(norm.length, 4);                      // 12,13,14,15 complete; 16:00 excluded
  assert.equal(norm[norm.length - 1].openMs, start + 3 * H1);
});

test('assembleD1/H4 over one clean EDT week: 5 trading days, 30 H4, no weekend candles', () => {
  const sunReopen = Date.UTC(2026, 6, 19, 21, 0);    // Sun 17:00 NY (EDT) reopen
  const friClose = Date.UTC(2026, 6, 24, 21, 0);     // Fri 17:00 NY close
  const h1 = gen(sunReopen, friClose);
  const d1 = T.assembleD1(h1, friClose);
  const h4 = T.assembleH4(h1, friClose);
  assert.equal(d1.length, 5);
  assert.equal(h4.length, 30);
  // no synthesized candle may start inside the closed weekend window
  for (const c of [...d1, ...h4]) assert.ok(T.isTradingSessionStart(T.sessionStartUtc(c.openMs)));
});

test('Sunday 17:00 NY reopen is assigned to Monday, not a standalone Sunday day', () => {
  const sun = Date.UTC(2026, 6, 19, 21, 30);         // Sun 17:30 NY
  const start = T.sessionStartUtc(sun);
  assert.equal(T.weekdayOfDate(...(() => { const p = T.partsInTz(start, 'America/New_York'); return [p.year, p.month, p.day]; })()), 0); // Sunday start
  assert.equal(T.sessionLabel(start), '2026-07-20');  // labelled Monday
});

test('weekend adds no candles → age counters do not grow over the weekend', () => {
  // Thursday-close hour + the following Monday-open hour, nothing between.
  const thu = Date.UTC(2026, 6, 23, 20, 0);          // Thu 16:00 NY
  const mon = Date.UTC(2026, 6, 27, 21, 0);          // Mon 17:00 NY (next week reopen)
  const h1 = [...gen(thu, thu + 2 * H1), ...gen(mon, mon + 2 * H1)];
  const h4 = T.assembleH4(h1, mon + 2 * H1);
  // no H4 bucket may fall in the Fri-close→Sun-reopen gap
  for (const c of h4) assert.ok(c.openMs <= thu + 2 * H1 || c.openMs >= mon);
});

test('Friday cutoff: final 4h before Friday 17:00 NY close', () => {
  const friClose = Date.UTC(2026, 6, 24, 21, 0);
  assert.equal(T.inFridayCutoff(friClose - 1 * H1), true);
  assert.equal(T.inFridayCutoff(friClose - 5 * H1), false);
  assert.equal(T.inFridayCutoff(friClose), false);   // at/after close is not "cutoff window"
});

test('closesAt orders D1 first at a 17:00 NY boundary (also H4 + H1)', () => {
  const boundary = Date.UTC(2026, 6, 21, 21, 0);     // Tue 17:00 NY (EDT) = a session boundary
  const c = T.closesAt(boundary);
  assert.deepEqual(c, { D1: true, H4: true, H1: true });
  assert.deepEqual(T.EVAL_ORDER, ['D1', 'H4', 'H1']);
});
