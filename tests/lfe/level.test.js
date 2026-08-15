'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  detectPivots, groupEqualLevels, previousDayLevels, mergeLevels, buildLevels, transitionLevel,
} = require('../../api/_lfe-level');
const { atrSeries } = require('../../api/_lfe-math');
const { LEVEL_TYPE, LEVEL_STATE, CONFIG } = require('../../api/_lfe-constants');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 7, 3, 0, 0, 0); // Monday 2026-08-03 00:00 UTC

// Build H1 candles from arrays of highs/lows; open/close centred in the range.
function candles(highs, lows, startMs) {
  startMs = startMs == null ? T0 : startMs;
  return highs.map((h, i) => {
    const low = lows[i];
    const mid = (h + low) / 2;
    return { openMs: startMs + i * HOUR, time: new Date(startMs + i * HOUR).toISOString(), open: mid, high: h, low, close: mid };
  });
}

test('a swing high is unavailable until both right-side candles have closed', () => {
  // Peak at index 3 (needs indices 1..5). Highs: 1,2,3,5,3,2,1
  const hs = [1, 2, 3, 5, 3, 2, 1];
  const ls = hs.map((h) => h - 1);
  const full = candles(hs, ls);
  const atr = atrSeries(full, CONFIG.atr.h1Period);

  // Only candles through index 4 → the i+2 (index 5) hasn't closed → no pivot at 3.
  const early = detectPivots(full.slice(0, 5), atrSeries(full.slice(0, 5), CONFIG.atr.h1Period), CONFIG);
  assert.ok(!early.some((p) => p.index === 3 && p.type === LEVEL_TYPE.SWING_HIGH));

  // Candles through index 5 → pivot confirmed, available at index-5 close.
  const conf = detectPivots(full.slice(0, 6), atrSeries(full.slice(0, 6), CONFIG.atr.h1Period), CONFIG);
  const piv = conf.find((p) => p.index === 3 && p.type === LEVEL_TYPE.SWING_HIGH);
  assert.ok(piv, 'pivot detected once confirmed');
  assert.equal(piv.availableAtMs, full[5].openMs + HOUR);
  assert.equal(piv.pivotAtMs, full[3].openMs);
});

test('a historical snapshot before available_at does not see the pivot', () => {
  const hs = [1, 2, 3, 5, 3, 2, 1];
  const ls = hs.map((h) => h - 1);
  const cs = candles(hs, ls);
  const atr = atrSeries(cs, CONFIG.atr.h1Period);
  const availableAt = cs[5].openMs + HOUR;

  // Short array → real ATR14 is undefined; inject atrNow so buildLevels runs.
  const before = buildLevels({ candles: cs, atr, atrNow: 1, pair: 'EUR_USD', evalMs: availableAt - 1 });
  assert.ok(!before.pivots.some((p) => p.index === 3));

  const after = buildLevels({ candles: cs, atr, atrNow: 1, pair: 'EUR_USD', evalMs: availableAt });
  assert.ok(after.pivots.some((p) => p.index === 3));
});

test('equal highs group when within tolerance and ≥3 candles apart', () => {
  const pivots = [
    { index: 2, type: LEVEL_TYPE.SWING_HIGH, price: 1.1000, pivotAtMs: T0 + 2 * HOUR, availableAtMs: T0 + 4 * HOUR },
    { index: 7, type: LEVEL_TYPE.SWING_HIGH, price: 1.1001, pivotAtMs: T0 + 7 * HOUR, availableAtMs: T0 + 9 * HOUR },
    { index: 12, type: LEVEL_TYPE.SWING_HIGH, price: 1.0999, pivotAtMs: T0 + 12 * HOUR, availableAtMs: T0 + 14 * HOUR },
  ];
  const levels = groupEqualLevels(pivots, 0.0030, 'EUR_USD', CONFIG); // tol = 0.10*ATR = 0.0003
  const eq = levels.find((l) => l.levelType === LEVEL_TYPE.EQUAL_HIGHS);
  assert.ok(eq);
  assert.equal(eq.touches, 3);
  assert.equal(eq.score, 15);
  assert.equal(eq.availableAtMs, T0 + 9 * HOUR); // 2nd touch confirmation
});

test('touches closer than 3 candles are not counted as separate touches', () => {
  const pivots = [
    { index: 2, type: LEVEL_TYPE.SWING_HIGH, price: 1.1000, pivotAtMs: T0 + 2 * HOUR, availableAtMs: T0 + 4 * HOUR },
    { index: 3, type: LEVEL_TYPE.SWING_HIGH, price: 1.1000, pivotAtMs: T0 + 3 * HOUR, availableAtMs: T0 + 5 * HOUR },
  ];
  const levels = groupEqualLevels(pivots, 0.0030, 'EUR_USD', CONFIG);
  assert.equal(levels.length, 0); // second touch too close → no 2-touch level
});

test('Monday previous-day levels use Friday, and no weekend level is created', () => {
  // Friday 2026-07-31 is a D1 candle; Sat/Sun have none. Eval Monday morning.
  const friOpen = Date.UTC(2026, 6, 31, 21, 0, 0); // ~17:00 NY
  const thuOpen = friOpen - DAY;
  const d1 = [
    { openMs: thuOpen, high: 1.2000, low: 1.1900, open: 1.195, close: 1.198 },
    { openMs: friOpen, high: 1.2100, low: 1.1950, open: 1.196, close: 1.205 },
  ];
  const mondayMorning = Date.UTC(2026, 7, 3, 8, 0, 0);
  const levels = previousDayLevels(d1, mondayMorning, 0.0030, 'EUR_USD', CONFIG);
  const hi = levels.find((l) => l.levelType === LEVEL_TYPE.PREV_DAY_HIGH);
  const lo = levels.find((l) => l.levelType === LEVEL_TYPE.PREV_DAY_LOW);
  assert.equal(hi.centre, 1.2100); // Friday's high, not Thursday's
  assert.equal(lo.centre, 1.1950);
  assert.equal(hi.availableAtMs, friOpen + DAY);
});

test('previous-day levels are empty when no D1 candle has closed yet', () => {
  const friOpen = Date.UTC(2026, 6, 31, 21, 0, 0);
  const d1 = [{ openMs: friOpen, high: 1.21, low: 1.19, open: 1.2, close: 1.2 }];
  const before = previousDayLevels(d1, friOpen + 1, 0.003, 'EUR_USD', CONFIG); // not yet closed
  assert.equal(before.length, 0);
});

test('overlapping same-orientation levels are merged, keeping the higher score', () => {
  const mk = (type, centre, score, avail) => ({
    pair: 'EUR_USD', levelType: type, orientation: 'resistance', centre,
    zoneLow: centre - 0.0001, zoneHigh: centre + 0.0001, touches: 1,
    firstTouchMs: avail, latestTouchMs: avail, availableAtMs: avail, score, state: 'ACTIVE', transitions: [],
  });
  const levels = [
    mk(LEVEL_TYPE.SWING_HIGH, 1.10000, 8, T0),
    mk(LEVEL_TYPE.EQUAL_HIGHS, 1.10010, 15, T0 + HOUR), // within 0.15*ATR (0.00045)
  ];
  const merged = mergeLevels(levels, 0.0030, CONFIG);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].levelType, LEVEL_TYPE.EQUAL_HIGHS);
  assert.equal(merged[0].score, 15);
  assert.equal(merged[0].touches, 2);
});

test('repeated evaluation at the same timestamp is byte-for-byte identical', () => {
  const hs = [1, 2, 3, 5, 3, 2, 3, 5.001, 3, 2, 1, 2, 3, 5, 3, 2, 1];
  const ls = hs.map((h) => h - 1);
  const cs = candles(hs, ls);
  const evalMs = cs[cs.length - 1].openMs + HOUR;
  const a = buildLevels({ candles: cs, pair: 'EUR_USD', evalMs });
  const b = buildLevels({ candles: cs, pair: 'EUR_USD', evalMs });
  assert.deepEqual(a, b);
});

test('lifecycle transitions append without overwriting history', () => {
  const lvl = { pair: 'EUR_USD', levelType: LEVEL_TYPE.SWING_HIGH, centre: 1.1, state: LEVEL_STATE.ACTIVE, transitions: [] };
  transitionLevel(lvl, LEVEL_STATE.BREACHED, T0 + HOUR, 'break');
  transitionLevel(lvl, LEVEL_STATE.FAILED, T0 + 2 * HOUR, 'reject');
  assert.equal(lvl.state, LEVEL_STATE.FAILED);
  assert.equal(lvl.transitions.length, 2);
  assert.equal(lvl.transitions[0].toState, LEVEL_STATE.BREACHED);
  assert.equal(lvl.transitions[1].fromState, LEVEL_STATE.BREACHED);
});
