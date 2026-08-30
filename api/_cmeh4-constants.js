'use strict';

/**
 * NervaFX Currency Movement Engine — H4 variant constants (isolated).
 *
 * Same decomposition as the H1/30M engines, but the STRUCTURAL / PRIMARY
 * timeframe is H4 (synthesized from four H1 candles — backtest_candles has no
 * native H4) with H1 as the micro-confirmation layer, and a Break of Structure
 * is a decisive close beyond the previous 5 completed H4 candles (a 20-hour
 * structure window).
 */

const base = require('./_cme-constants');

const ENGINE_KEY = 'currency_movement_engine_h4';
const ENGINE_VERSION = 'v1';
const CONFIGURATION_VERSION = 'structure_h4_v1';

const BASE_MS = 4 * 60 * 60 * 1000;      // primary timeframe step (4h, synthesized)
const MICRO_MS = base.HOUR_MS;           // micro timeframe step (H1)
const MICRO_PER_BASE = 4;                // four H1 candles per H4

// BOS: same thresholds, structure window 5 candles.
const BOS = Object.freeze(Object.assign({}, base.BOS, { STRUCTURE_LOOKBACK: 5 }));

const WINDOWS = Object.freeze(['H4', 'H1', 'REFERENCE_SESSION', 'ASIA_TO_DATE', 'LONDON_TO_DATE', 'DAY_TO_DATE']);

module.exports = {
  ENGINE_KEY, ENGINE_VERSION, CONFIGURATION_VERSION, BOS,
  HOUR_MS: base.HOUR_MS, BASE_MS, MICRO_MS, MICRO_PER_BASE,
  CURRENCIES: base.CURRENCIES, PAIRS: base.PAIRS,
  ATR_PERIOD: base.ATR_PERIOD,
  EAT_TZ: base.EAT_TZ, LONDON_TZ: base.LONDON_TZ,
  SESSION_START_HOUR: base.SESSION_START_HOUR, SESSION_END_HOUR: base.SESSION_END_HOUR, LONDON_OPEN_HOUR: base.LONDON_OPEN_HOUR,
  WINDOWS, STATES: base.STATES, stateForScore: base.stateForScore,
  WEIGHTS: base.WEIGHTS, ACCEL_BLEND: base.ACCEL_BLEND, MAGNITUDE_FULL_SCALE: base.MAGNITUDE_FULL_SCALE,
};
