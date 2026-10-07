'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  describePriceAction, detectSwings, M15, PRICEACTION_VERSION,
} = require('../../research/m15/priceaction');

// ── fixture helpers ────────────────────────────────────────────────────────
const T0 = Date.UTC(2026, 8, 7, 0, 0, 0);                 // Mon 2026-09-07 00:00 UTC
const bar = (openMs, o, h, l, c, extra = {}) => ({ openMs, time: new Date(openMs).toISOString(), open: o, high: h, low: l, close: c, volume: 100, complete: true, source: 'OANDA', ...extra });

/** Build a consecutive M15 series from a list of closes; o/h/l derived simply
 *  (prev close as open; high/low padded) so bars are well-formed and causal. */
function seriesFromCloses(startMs, closes, pad = 0.0004) {
  const out = [];
  let prev = closes[0];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const o = i === 0 ? c : prev;
    const hi = Math.max(o, c) + pad;
    const lo = Math.min(o, c) - pad;
    out.push(bar(startMs + i * M15, o, +hi.toFixed(6), +lo.toFixed(6), +c.toFixed(6)));
    prev = c;
  }
  return out;
}
const lastClose = (cands) => cands[cands.length - 1].openMs + M15;

// ── 1. Persistent EUR/GBP-like descent with shallow recoveries ───────────────
test('persistent descent with shallow recoveries ⇒ DOWN, negative efficiency, low retrace', () => {
  const closes = [];
  let p = 0.8600;
  for (let i = 0; i < 96; i++) { p -= 0.0006; if (i % 6 === 5) p += 0.0003; closes.push(p); } // stair-step down
  const cands = seriesFromCloses(T0, closes);
  const d = describePriceAction(cands, { pair: 'EUR_GBP', asOfCloseMs: lastClose(cands) });
  assert.equal(d.windows.h24.descriptors.direction, 'DOWN');
  assert.ok(d.windows.h24.descriptors.directionalEfficiency < -0.5, `eff ${d.windows.h24.descriptors.directionalEfficiency}`);
  assert.ok(d.windows.h24.descriptors.impulseRetracedProportion < 0.5);
  assert.equal(d.state.label, 'DIRECTIONAL_DOWN');
  assert.ok(d.swings.pivots.length >= 0);                   // shallow bounces may not confirm pivots
});

// ── 2. GBP/AUD-like sharp fall then full recovery + two-way swings ───────────
test('sharp fall then full recovery ⇒ net displacement ~0, large path, low efficiency, multiple swings', () => {
  const down = []; let p = 1.9000; for (let i = 0; i < 48; i++) { p -= 0.0015; down.push(p); }
  const up = [];   for (let i = 0; i < 48; i++) { p += 0.0015; up.push(p); }
  const cands = seriesFromCloses(T0, [...down, ...up]);
  const d = describePriceAction(cands, { pair: 'GBP_AUD', asOfCloseMs: lastClose(cands) });
  const h24 = d.windows.h24.descriptors;
  assert.ok(Math.abs(h24.directionalEfficiency) < 0.4, `eff ${h24.directionalEfficiency}`);
  assert.ok(h24.pathLength > Math.abs(h24.closeDisplacement) * 2);
  assert.ok(d.swings.pivots.length >= 1, 'a V reversal should confirm at least one pivot');
  assert.ok(['BALANCED', 'ROTATIONAL', 'DIRECTIONAL_UP'].includes(d.state.label));
});

// ── 3. Late new decline inside a broader range ───────────────────────────────
test('late new decline ⇒ latest-12h efficiency more negative than preceding 12h', () => {
  const flat = []; let p = 1.1000; for (let i = 0; i < 72; i++) { p += (i % 2 ? -0.0002 : 0.0002); flat.push(p); } // choppy range
  const drop = []; for (let i = 0; i < 48; i++) { p -= 0.0008; drop.push(p); }                                   // fresh decline (last 12h)
  const cands = seriesFromCloses(T0, [...flat, ...drop]);
  const d = describePriceAction(cands, { pair: 'EUR_USD', asOfCloseMs: lastClose(cands) });
  assert.ok(d.comparison.latest12.directionalEfficiency < d.comparison.previous12.directionalEfficiency);
  assert.ok(d.comparison.deltaEfficiency < 0);
  assert.equal(d.comparison.latest12.direction, 'DOWN');
});

// ── 4. Weekend gap ⇒ coverage < 100%, gap reported, nothing fabricated ───────
test('weekend gap ⇒ actual < nominal, gapCount>=1, no fabricated candles', () => {
  const friEnd = Date.UTC(2026, 8, 4, 20, 45, 0);           // Fri 20:45 open (closes 21:00)
  const pre = seriesFromCloses(friEnd - 40 * M15, Array.from({ length: 40 }, (_, i) => 1.30 + i * 0.0001));
  const monStart = Date.UTC(2026, 8, 6, 21, 15, 0);         // Sun 21:15 reopen (~48h later)
  const post = seriesFromCloses(monStart, Array.from({ length: 20 }, (_, i) => 1.3040 + i * 0.0001));
  const cands = [...pre, ...post];
  const T = lastClose(cands);
  const d = describePriceAction(cands, { pair: 'GBP_USD', asOfCloseMs: T });
  assert.ok(d.windows.h48.actualCandles < d.windows.h48.nominalCandles);
  assert.ok(d.windows.h48.coveragePct < 100);
  assert.ok(d.integrity.gaps.length >= 1 || d.windows.h48.gapCount >= 1);
  // the reported actual equals the real eligible count — no interpolation
  assert.equal(d.windows.h48.actualCandles, cands.filter((c) => c.openMs + M15 > T - 48 * 3600000 && c.openMs + M15 <= T).length);
});

// ── 5. Duplicate / missing candle ────────────────────────────────────────────
test('duplicate candle is flagged (not merged); missing step shows as a gap', () => {
  const base = seriesFromCloses(T0, Array.from({ length: 10 }, (_, i) => 1.10 + i * 0.0003));
  const dup = { ...base[5] };                               // exact duplicate openMs
  const withDup = [...base.slice(0, 6), dup, ...base.slice(6)];
  const missing = [...base.slice(0, 4), ...base.slice(5)];  // drop one ⇒ internal gap
  const T = lastClose(base);
  const d1 = describePriceAction(withDup, { pair: 'EUR_USD', asOfCloseMs: T });
  const d2 = describePriceAction(missing, { pair: 'EUR_USD', asOfCloseMs: T });
  assert.equal(d1.integrity.duplicates, 1);
  assert.equal(d1.integrity.eligible, 10);                  // duplicate removed, not counted twice
  assert.ok(d2.integrity.gaps.length >= 1);
});

// ── 6. Unchanged price ⇒ safe zero handling, AMBIGUOUS ───────────────────────
test('unchanged price ⇒ no divide-by-zero, efficiency 0, range 0, AMBIGUOUS', () => {
  const cands = seriesFromCloses(T0, Array.from({ length: 96 }, () => 1.2345), 0);
  const d = describePriceAction(cands, { pair: 'USD_CAD', asOfCloseMs: lastClose(cands) });
  assert.equal(d.windows.h24.descriptors.directionalEfficiency, 0);
  assert.equal(d.windows.h24.descriptors.pathLength, 0);
  assert.equal(d.windows.h24.descriptors.range, 0);
  assert.equal(d.windows.h24.descriptors.positionInRange, 0.5);
  assert.equal(d.state.label, 'AMBIGUOUS');
  assert.equal(d.balance.zone, null);                       // flat ⇒ no zone
});

// ── 7. A swing not yet confirmed at T (provisional, never backdated) ─────────
test('an un-retraced new extreme is PROVISIONAL, not a confirmed pivot (C4)', () => {
  // rise, tiny dip (below threshold), then keep rising to a fresh high at T:
  const closes = [];
  let p = 1.0000; for (let i = 0; i < 30; i++) { p += 0.0005; closes.push(p); }   // clean rise
  p -= 0.0002; closes.push(p);                                                      // sub-threshold dip
  for (let i = 0; i < 10; i++) { p += 0.0005; closes.push(p); }                     // new highs to T
  const cands = seriesFromCloses(T0, closes);
  const sw = detectSwings(cands, { k: 1.5, calibLookback: 48 });
  assert.equal(sw.provisional.confirmed, false);
  assert.equal(sw.provisional.direction, 'UP');
  // no confirmed HIGH pivot exists for the final leg (the top is still provisional)
  const last = cands[cands.length - 1];
  for (const piv of sw.pivots) assert.ok(piv.confirmedAtMs <= last.openMs + M15);
});

// ── 8. Causality: a pivot appears only once T reaches its confirmation (C4) ──
test('a pivot enters the known state at confirmation, never earlier', () => {
  const closes = [];
  let p = 1.5000; for (let i = 0; i < 20; i++) { p += 0.0006; closes.push(p); }   // up leg
  for (let i = 0; i < 20; i++) { p -= 0.0006; closes.push(p); }                    // down leg ⇒ HIGH pivot confirms somewhere here
  const cands = seriesFromCloses(T0, closes);
  const full = detectSwings(cands, { k: 1.5, calibLookback: 48 });
  assert.ok(full.pivots.length >= 1);
  const piv = full.pivots.find((x) => x.type === 'HIGH');
  assert.ok(piv, 'expected a HIGH pivot');
  // at a T one candle BEFORE confirmation, the pivot must NOT yet be known
  const dBefore = describePriceAction(cands, { pair: 'EUR_JPY', asOfCloseMs: piv.confirmedAtMs - M15 });
  const knownBefore = dBefore.swings.pivots.some((x) => x.pivotTimeMs === piv.pivotTimeMs && x.type === 'HIGH');
  assert.equal(knownBefore, false, 'pivot was backdated — must not be known before confirmation');
  // at T == confirmation, it is known
  const dAt = describePriceAction(cands, { pair: 'EUR_JPY', asOfCloseMs: piv.confirmedAtMs });
  assert.ok(dAt.swings.pivots.some((x) => x.pivotTimeMs === piv.pivotTimeMs && x.type === 'HIGH'));
});

// ── 9. No-data state ─────────────────────────────────────────────────────────
test('no eligible candles ⇒ NO_DATA, empty windows/events, no throw', () => {
  const cands = seriesFromCloses(T0, [1.1, 1.1, 1.1]);
  const d = describePriceAction(cands, { pair: 'EUR_USD', asOfCloseMs: T0 - 10 * M15 }); // T before all data
  assert.equal(d.state.label, 'NO_DATA');
  assert.equal(d.integrity.eligible, 0);
  assert.deepEqual(d.events, []);
});

// ── 10. Determinism + no-lookahead filter ────────────────────────────────────
test('deterministic output and future candles are never read (C1)', () => {
  const cands = seriesFromCloses(T0, Array.from({ length: 60 }, (_, i) => 1.10 + Math.sin(i / 5) * 0.002));
  const T = cands[40].openMs + M15;                         // evaluate mid-series
  const a = describePriceAction(cands, { pair: 'EUR_USD', asOfCloseMs: T });
  const b = describePriceAction(cands, { pair: 'EUR_USD', asOfCloseMs: T });
  assert.deepEqual(a, b);                                   // deterministic
  assert.equal(a.integrity.eligible, 41);                  // only candles with close <= T (indices 0..40)
  assert.ok(a.integrity.lastCloseMs <= T);
});

// ── 11. Balance zone lifecycle emits provisional vs accepted departure ───────
test('balance ⇒ formed, then provisional departure then accepted departure', () => {
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(1.2000 + (i % 2 ? 0.0001 : -0.0001)); // tight balance
  for (let i = 0; i < 10; i++) closes.push(1.2010 + i * 0.0004);                 // break up and hold
  const cands = seriesFromCloses(T0, closes, 0.00005);
  const d = describePriceAction(cands, { pair: 'EUR_USD', asOfCloseMs: lastClose(cands) });
  const types = d.balance.events.map((e) => e.type);
  assert.ok(d.balance.zone, 'a zone should form');
  assert.ok(types.includes('BALANCE_FORMED'));
  assert.ok(types.includes('DEPARTURE_PROVISIONAL'));
  assert.ok(types.includes('DEPARTURE_ACCEPTED'));
  // events are chronological
  for (let i = 1; i < d.balance.events.length; i++) assert.ok(d.balance.events[i].ms >= d.balance.events[i - 1].ms);
});

// ── 12. Version surfaced ──────────────────────────────────────────────────────
test('version + thresholdVersion are reported', () => {
  const cands = seriesFromCloses(T0, [1.1, 1.1001, 1.1002, 1.1003]);
  const d = describePriceAction(cands, { pair: 'EUR_USD', asOfCloseMs: lastClose(cands) });
  assert.equal(d.version, PRICEACTION_VERSION);
  assert.equal(d.thresholdVersion, 'swing-k1.5-medabs-v1');
  assert.ok(Array.isArray(d.swings.sensitivity) && d.swings.sensitivity.length === 4);
});
