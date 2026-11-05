'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { candleMetrics, breadth } = require('../../research/comparison/candles');
const { completedDays, todaySoFar, completedSessions, zonedToUtc, dayStart, weekStart, monthStart, weekSoFar, monthSoFar } = require('../../research/comparison/periods');
const { CONFIG, DAY_MS, M15_MS } = require('../../research/comparison/config');

test('candle metrics: body/wick/close-location and signed return', () => {
  const m = candleMetrics({ open: 100, high: 110, low: 90, close: 105 }, CONFIG);
  assert.equal(m.returnPct, 5);
  assert.equal(m.direction, 'appreciation');
  assert.equal(m.bodyPct, 25);
  assert.equal(m.upperWickPct, 25);
  assert.equal(m.lowerWickPct, 50);
  assert.equal(m.closeLocationPct, 75);
});

test('zero-range candle → N/A flat, not NaN', () => {
  const m = candleMetrics({ open: 100, high: 100, low: 100, close: 100 }, CONFIG);
  assert.equal(m.flat, true);
  assert.equal(m.bodyPct, null);
  assert.equal(m.direction, 'unchanged');
  assert.ok(/N\/A/.test(m.note));
});

test('breadth uses oriented pair returns (quote currency handled)', () => {
  const START = Date.UTC(2025, 4, 1);
  const bar = (i, px) => ({ openMs: START + i * M15_MS, open: px, high: px, low: px, close: px });
  const by = {};
  // only EUR_USD rises; for USD (quote in EUR_USD) that is a depreciation
  require('../../research/comparison/config').PAIRS.forEach((p) => { by[p] = [bar(0, 1), bar(1, 1), bar(2, 1)]; });
  by['EUR_USD'] = [bar(0, 1.10), bar(1, 1.10), bar(2, 1.12)];
  const b = breadth('USD', by, START + M15_MS, START + 3 * M15_MS, CONFIG);
  const leg = b.per.find((x) => x.pair === 'EUR_USD');
  assert.equal(leg.classification, 'depreciated');   // USD fell vs EUR
  assert.equal(b.depreciated >= 1, true);
  assert.equal(b.coverage.valid, 7);
});

test('completedDays: UTC day bounds, no look-ahead past asOf', () => {
  const asOf = Date.UTC(2026, 0, 10, 12, 0, 0);   // mid-day Jan 10
  const days = completedDays(asOf, asOf, 3);
  assert.equal(days.length, 3);
  const latest = days[days.length - 1];
  assert.equal(latest.endMs, dayStart(asOf));      // Jan 10 00:00 — Jan 9 is the latest complete day
  assert.equal(latest.startMs, dayStart(asOf) - DAY_MS);
  for (const d of days) assert.ok(d.endMs <= asOf);
});

test('todaySoFar: developing day + prior days at the SAME elapsed cutoff', () => {
  const asOf = Date.UTC(2026, 0, 10, 10, 15, 0);
  const ps = todaySoFar(asOf, asOf, 2);
  const dev = ps[ps.length - 1];
  assert.equal(dev.status, 'developing');
  assert.equal(dev.endMs, asOf);
  assert.equal(dev.elapsedMs, asOf - dayStart(asOf));
  // prior days use the same elapsed offset
  assert.equal(ps[0].endMs - ps[0].startMs, dev.elapsedMs);
});

test('weekStart is Monday 00:00 UTC; weekSoFar is developing + prior weeks at same elapsed', () => {
  // 2026-01-07 is a Wednesday 10:00 UTC
  const asOf = Date.UTC(2026, 0, 7, 10, 15, 0);
  const ws = weekStart(asOf);
  assert.equal(new Date(ws).getUTCDay(), 1);         // Monday
  assert.equal(ws, Date.UTC(2026, 0, 5));            // Mon 2026-01-05 00:00
  const ps = weekSoFar(asOf, asOf, 2);
  const dev = ps[ps.length - 1];
  assert.equal(dev.status, 'developing');
  assert.equal(dev.startMs, ws);
  assert.equal(dev.endMs, asOf);
  assert.equal(dev.elapsedMs, asOf - ws);
  // prior weeks are exactly 7 days earlier, same elapsed length
  assert.equal(ps[1].startMs, ws - 7 * 24 * 3600000);
  assert.equal(ps[0].endMs - ps[0].startMs, dev.elapsedMs);
});

test('monthStart is the 1st 00:00 UTC; monthSoFar developing + prior months (elapsed capped)', () => {
  const asOf = Date.UTC(2026, 2, 10, 12, 0, 0);      // 2026-03-10 12:00
  const ms = monthStart(asOf);
  assert.equal(ms, Date.UTC(2026, 2, 1));
  const ps = monthSoFar(asOf, asOf, 2);
  const dev = ps[ps.length - 1];
  assert.equal(dev.status, 'developing');
  assert.equal(dev.startMs, Date.UTC(2026, 2, 1));
  assert.equal(ps[1].startMs, Date.UTC(2026, 1, 1)); // Feb
  assert.equal(ps[0].startMs, Date.UTC(2026, 0, 1)); // Jan
  // Feb is short: a 10-day elapsed fits, so the context ends mid-Feb, never spilling into March
  for (const p of ps) assert.ok(p.endMs <= asOf);
  assert.ok(ps[1].endMs <= Date.UTC(2026, 2, 1));    // Feb context ends within Feb
});

test('monthSoFar caps elapsed at a short prior month (no spill into next month)', () => {
  const asOf = Date.UTC(2026, 2, 31, 0, 0, 0);       // 2026-03-31: 30 days elapsed into March
  const ps = monthSoFar(asOf, asOf, 1);
  const feb = ps[0];
  assert.equal(feb.startMs, Date.UTC(2026, 1, 1));
  assert.ok(feb.endMs <= Date.UTC(2026, 2, 1));      // capped at Feb length, not Feb 1 + 30d
});

test('sessions are DST-aware: London 08:00 local = 07:00 UTC (BST) / 08:00 UTC (GMT)', () => {
  const bst = zonedToUtc('Europe/London', 2025, 7, 15, 8, 0);   // July → BST (UTC+1)
  const gmt = zonedToUtc('Europe/London', 2025, 1, 15, 8, 0);   // January → GMT (UTC+0)
  assert.equal(new Date(bst).getUTCHours(), 7);
  assert.equal(new Date(gmt).getUTCHours(), 8);
  // completedSessions never returns an unfinished session
  const sess = completedSessions('london', Date.UTC(2025, 6, 15, 12, 0), Date.UTC(2025, 6, 15, 12, 0), 2);
  for (const s of sess) assert.ok(s.endMs <= Date.UTC(2025, 6, 15, 12, 0));
});
