'use strict';

/**
 * NervaFX Currency Movement Engine — 30M variant constants (isolated).
 *
 * Same decomposition as the H1/15M engines, but the STRUCTURAL / PRIMARY
 * timeframe is M30 (synthesized from two M15 candles — backtest_candles has no
 * native M30) with M15 as the micro-confirmation layer, and a Break of Structure
 * is a decisive close beyond the previous 10 completed M30 candles.
 */

const base = require('./_cme-constants');

const ENGINE_KEY = 'currency_movement_engine_30m';
const ENGINE_VERSION = 'v1';
const CONFIGURATION_VERSION = 'structure_30m_v1';

const BASE_MS = 30 * 60 * 1000;          // primary timeframe step (30 min, synthesized)
const MICRO_MS = base.M15_MS;            // micro timeframe step (15 min)
const MICRO_PER_BASE = 2;                // two M15 candles per M30

// BOS: same thresholds, structure window 10 candles.
const BOS = Object.freeze(Object.assign({}, base.BOS, { STRUCTURE_LOOKBACK: 10 }));

const WINDOWS = Object.freeze(['M30', 'M15', 'REFERENCE_SESSION', 'ASIA_TO_DATE', 'LONDON_TO_DATE', 'DAY_TO_DATE']);

module.exports = {
  ENGINE_KEY, ENGINE_VERSION, CONFIGURATION_VERSION, BOS,
  HOUR_MS: base.HOUR_MS, BASE_MS, MICRO_MS, MICRO_PER_BASE, M15_MS: base.M15_MS,
  CURRENCIES: base.CURRENCIES, PAIRS: base.PAIRS,
  ATR_PERIOD: base.ATR_PERIOD, MIN_15M_HISTORY: base.MIN_15M_HISTORY,
  EAT_TZ: base.EAT_TZ, LONDON_TZ: base.LONDON_TZ,
  SESSION_START_HOUR: base.SESSION_START_HOUR, SESSION_END_HOUR: base.SESSION_END_HOUR, LONDON_OPEN_HOUR: base.LONDON_OPEN_HOUR,
  WINDOWS, STATES: base.STATES, stateForScore: base.stateForScore,
  WEIGHTS: base.WEIGHTS, ACCEL_BLEND: base.ACCEL_BLEND, MAGNITUDE_FULL_SCALE: base.MAGNITUDE_FULL_SCALE,
};
