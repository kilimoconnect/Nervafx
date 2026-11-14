'use strict';

/**
 * Breakout Strength & Signals — configuration (versioned research defaults).
 *
 * One deterministic methodology, three INDEPENDENT strategies:
 *
 *   latest qualifying higher-timeframe break of structure (per pair)
 *     → currency strength (±1 base/quote votes)
 *     → strong-vs-weak pair qualification
 *     → fresh lower-timeframe break of structure → signal.
 *
 *   strategy   direction/strength TF   entry-trigger TF
 *   daily      D1                      H1
 *   weekly     W1                      H4
 *   monthly    MN1                     D1
 *
 * A strategy never requires agreement with another: a currency can be strong on
 * Daily and weak on Monthly. Candle boundaries are EAT (UTC+3, no DST), aggregated
 * from stored H1 (see candles.js). Research only — NO orders, stops, targets, or
 * profitability/win-rate claims; a trigger close is a reference price, not a fill.
 */

const { CURRENCIES, PAIRS, pairFor, legsFor } = require('../comparison/config');
const { dayStart, h4Start, weekStart, monthStart, EAT_OFFSET_MS } = require('../comparison/periods');

const HOUR_MS = 60 * 60 * 1000;
const H4_MS = 4 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

// Timeframe metadata. `boundary(ms)` returns the EAT-aligned open of the bucket
// containing ms; `nextBoundary(openMs)` returns the next bucket open (= this bucket close).
const TF = {
  H1: {
    key: 'H1', label: 'H1', ms: HOUR_MS, aggregated: false,
    boundary: (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS,          // stored hourly (UTC hour == EAT hour)
    nextBoundary: (openMs) => openMs + HOUR_MS,
  },
  H4: {
    key: 'H4', label: 'H4', ms: H4_MS, aggregated: true,
    boundary: h4Start,                                            // 00/04/08/12/16/20 EAT
    nextBoundary: (openMs) => openMs + H4_MS,
  },
  D1: {
    key: 'D1', label: 'D1', ms: DAY_MS, aggregated: true,
    boundary: dayStart,                                           // 00:00 EAT
    nextBoundary: (openMs) => openMs + DAY_MS,
  },
  W1: {
    key: 'W1', label: 'W1', ms: 7 * DAY_MS, aggregated: true,
    boundary: weekStart,                                          // Monday 00:00 EAT
    nextBoundary: (openMs) => openMs + 7 * DAY_MS,
  },
  MN1: {
    key: 'MN1', label: 'MN1', ms: 30 * DAY_MS, aggregated: true,  // nominal; months vary
    boundary: monthStart,                                         // 1st 00:00 EAT
    nextBoundary: (openMs) => monthStart(openMs + 32 * DAY_MS),   // start of the next EAT month
  },
};

const STRATEGIES = {
  daily:   { key: 'daily',   label: 'Daily',   dirTf: 'D1',  triggerTf: 'H1', version: 'bss-d-1.0.0' },
  weekly:  { key: 'weekly',  label: 'Weekly',  dirTf: 'W1',  triggerTf: 'H4', version: 'bss-w-1.0.0' },
  monthly: { key: 'monthly', label: 'Monthly', dirTf: 'MN1', triggerTf: 'D1', version: 'bss-m-1.0.0' },
};
const STRATEGY_KEYS = ['daily', 'weekly', 'monthly'];

// Strong/weak classification threshold — a CONFIGURABLE ASSUMPTION. One symmetric
// integer threshold in [4,7] so strong and weak can never overlap (7 contributions).
const DEFAULT_PARAMS = { strongThreshold: 5 };
const MIN_THRESHOLD = 4, MAX_THRESHOLD = 7;

/** Clamp/validate a strong-threshold to an integer in [4,7]; default 5 on bad input. */
function validThreshold(t) {
  const n = Math.round(Number(t));
  if (!Number.isFinite(n)) return DEFAULT_PARAMS.strongThreshold;
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, n));
}

function strategyDef(key, paramOverrides) {
  const s = STRATEGIES[key];
  if (!s) throw new Error('unknown strategy: ' + key);
  const params = { strongThreshold: validThreshold((paramOverrides || {}).strongThreshold != null ? paramOverrides.strongThreshold : DEFAULT_PARAMS.strongThreshold) };
  return { ...s, params };
}

module.exports = {
  CURRENCIES, PAIRS, pairFor, legsFor,
  HOUR_MS, H4_MS, DAY_MS, EAT_OFFSET_MS,
  TF, STRATEGIES, STRATEGY_KEYS, DEFAULT_PARAMS, MIN_THRESHOLD, MAX_THRESHOLD,
  validThreshold, strategyDef,
};
