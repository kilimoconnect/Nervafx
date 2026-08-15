'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeCoverage } = require('../../api/_lfe-coverage');
const { CONFIG } = require('../../api/_lfe-constants');

const HOUR = 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const iso = (s) => new Date(s).getTime();

// Mirrors the live probe result: uniform H1, slight M15 lag on USD_CAD.
const perPair = {
  EUR_USD: {
    h1Earliest: '2025-05-19T13:00:00Z', h1Latest: '2026-08-14T15:00:00Z',
    m15Earliest: '2025-05-19T13:15:00Z', m15Latest: '2026-08-14T16:15:00Z',
  },
  AUD_CAD: {
    h1Earliest: '2025-05-19T13:00:00Z', h1Latest: '2026-08-14T15:00:00Z',
    m15Earliest: '2025-05-19T13:30:00Z', m15Latest: '2026-08-14T16:15:00Z',
  },
  USD_CAD: {
    h1Earliest: '2025-05-19T13:00:00Z', h1Latest: '2026-08-14T15:00:00Z',
    m15Earliest: '2025-05-19T13:15:00Z', m15Latest: '2026-08-14T16:00:00Z',
  },
};

test('computeCoverage derives common bounds (never hardcoded)', () => {
  const c = computeCoverage(perPair, CONFIG);
  assert.equal(c.ok, true);
  // commonEarliestRaw = latest of each pair's max(H1,M15) earliest = AUD_CAD M15 13:30
  assert.equal(c.commonEarliestRawIso, '2025-05-19T13:30:00.000Z');
  // latestAvailable is H1-limited (15:00 close = 16:00) for all pairs → 16:00
  assert.equal(c.commonLatestIso, '2026-08-14T16:00:00.000Z');
});

test('earliestSelectable adds the larger warmup window (300 H1 candles)', () => {
  const c = computeCoverage(perPair, CONFIG);
  const warmup = Math.max(CONFIG.history.minH1 * HOUR, CONFIG.history.minM15 * M15);
  assert.equal(warmup, 300 * HOUR); // 300h > 500*15m=125h
  assert.equal(c.earliestSelectable, iso('2025-05-19T13:30:00Z') + warmup);
});

test('latestAvailable is M15-aligned', () => {
  const c = computeCoverage(perPair, CONFIG);
  assert.equal(c.latestAvailable % M15, 0);
});

test('missing timeframe data is flagged, not fatal', () => {
  const c = computeCoverage({
    EUR_USD: perPair.EUR_USD,
    GBP_USD: { h1Earliest: null, h1Latest: null, m15Earliest: null, m15Latest: null },
  }, CONFIG);
  assert.equal(c.ok, true);
  assert.ok(c.warnings.some((w) => w.pair === 'GBP_USD' && w.type === 'MISSING_DATA'));
});

test('lagging latest close is flagged as advisory', () => {
  const lag = {
    EUR_USD: perPair.EUR_USD,
    SLOW_ONE: {
      h1Earliest: '2025-05-19T13:00:00Z', h1Latest: '2026-08-14T12:00:00Z',
      m15Earliest: '2025-05-19T13:15:00Z', m15Latest: '2026-08-14T12:00:00Z',
    },
  };
  const c = computeCoverage(lag, CONFIG);
  assert.ok(c.warnings.some((w) => w.pair === 'SLOW_ONE' && w.type === 'LAGGING_LATEST'));
});

test('empty input yields NO_COVERAGE', () => {
  const c = computeCoverage({}, CONFIG);
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'NO_COVERAGE');
});
