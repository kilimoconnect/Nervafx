'use strict';

/**
 * NervaFX Currency Movement Engine — 5M variant constants (isolated).
 *
 * Same decomposition as the H1/30M/15M engines, but the STRUCTURAL / PRIMARY
 * timeframe is M5 and a Break of Structure is a decisive close beyond the
 * previous 60 completed M5 candles. There is no micro layer (M5 is the finest
 * timeframe stored in backtest_candles).
 */

const base = require('./_cme-constants');

const ENGINE_KEY = 'currency_movement_engine_5m';
const ENGINE_VERSION = 'v1';
const CONFIGURATION_VERSION = 'structure_5m_v1';

const BASE_MS = 5 * 60 * 1000;           // primary timeframe step (5 min)

// BOS: same thresholds, structure window 60 candles.
const BOS = Object.freeze(Object.assign({}, base.BOS, { STRUCTURE_LOOKBACK: 60 }));

const WINDOWS = Object.freeze(['M5', 'REFERENCE_SESSION', 'ASIA_TO_DATE', 'LONDON_TO_DATE', 'DAY_TO_DATE']);

module.exports = {
  ENGINE_KEY, ENGINE_VERSION, CONFIGURATION_VERSION, BOS,
  HOUR_MS: base.HOUR_MS, BASE_MS,
  CURRENCIES: base.CURRENCIES, PAIRS: base.PAIRS,
  ATR_PERIOD: base.ATR_PERIOD,
  EAT_TZ: base.EAT_TZ, LONDON_TZ: base.LONDON_TZ,
  SESSION_START_HOUR: base.SESSION_START_HOUR, SESSION_END_HOUR: base.SESSION_END_HOUR, LONDON_OPEN_HOUR: base.LONDON_OPEN_HOUR,
  WINDOWS, STATES: base.STATES, stateForScore: base.stateForScore,
  WEIGHTS: base.WEIGHTS, ACCEL_BLEND: base.ACCEL_BLEND, MAGNITUDE_FULL_SCALE: base.MAGNITUDE_FULL_SCALE,
};
