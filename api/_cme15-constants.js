'use strict';

/**
 * NervaFX Currency Movement Engine — 15M variant constants (isolated twin).
 *
 * Identical decomposition to the H1 engine, but the STRUCTURAL / PRIMARY
 * timeframe is M15 (with M5 as the micro-confirmation layer) and a Break of
 * Structure is a decisive close beyond the previous 20 completed M15 candles.
 * Fully separate engine key / configuration / persistence / route / UI so the
 * H1 engine (currency_movement_engine) is never touched.
 *
 * Shared numeric/pure config (currencies, pairs, weights, states, session
 * hours) is re-exported from the H1 constants so the two engines stay in lock-
 * step on everything except the timeframe + BOS lookback.
 */

const base = require('./_cme-constants');

const ENGINE_KEY = 'currency_movement_engine_15m';
const ENGINE_VERSION = 'v1';
const CONFIGURATION_VERSION = 'structure_15m_v1';

const M15_MS = base.M15_MS;              // primary timeframe step (15 min)
const M5_MS = 5 * 60 * 1000;             // micro timeframe step (5 min)
const MICRO_PER_BASE = 3;                // three M5 candles per M15

// BOS: same thresholds as H1, but the structure window is 20 candles (not 5).
const BOS = Object.freeze(Object.assign({}, base.BOS, { STRUCTURE_LOOKBACK: 20 }));

// Same six-window layout as the H1 page; the primary/finer "spot" windows shift
// down one timeframe (M15 primary, M5 finer). Session/to-date windows keep the
// same time spans but decompose per-M15 step.
const WINDOWS = Object.freeze(['M15', 'M5', 'REFERENCE_SESSION', 'ASIA_TO_DATE', 'LONDON_TO_DATE', 'DAY_TO_DATE']);

module.exports = {
  ENGINE_KEY, ENGINE_VERSION, CONFIGURATION_VERSION, BOS,
  HOUR_MS: base.HOUR_MS, M15_MS, M5_MS, MICRO_PER_BASE,
  CURRENCIES: base.CURRENCIES, PAIRS: base.PAIRS,
  ATR_PERIOD: base.ATR_PERIOD, MIN_15M_HISTORY: base.MIN_15M_HISTORY,
  EAT_TZ: base.EAT_TZ, LONDON_TZ: base.LONDON_TZ,
  SESSION_START_HOUR: base.SESSION_START_HOUR, SESSION_END_HOUR: base.SESSION_END_HOUR, LONDON_OPEN_HOUR: base.LONDON_OPEN_HOUR,
  WINDOWS, STATES: base.STATES, stateForScore: base.stateForScore,
  WEIGHTS: base.WEIGHTS, ACCEL_BLEND: base.ACCEL_BLEND, MAGNITUDE_FULL_SCALE: base.MAGNITUDE_FULL_SCALE,
};
