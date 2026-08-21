'use strict';

/**
 * NervaFX Currency Movement Engine — constants (isolated, separately versioned).
 *
 * Decomposes the movement of the eight individual currencies from all 28 FX
 * pairs using pair log returns. Reuses shared candle/tz/ATR utilities only;
 * its own calculations, routes, persistence and UI are separate.
 */

const ENGINE_KEY = 'currency_movement_engine';
const ENGINE_VERSION = 'v1';

const HOUR_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;

const CURRENCIES = Object.freeze(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);

// All 28 unique pairs (provider base_quote), matching backtest_candles.instrument.
const PAIRS = Object.freeze([
  'AUD_CAD', 'AUD_CHF', 'AUD_JPY', 'AUD_NZD', 'AUD_USD',
  'CAD_CHF', 'CAD_JPY', 'CHF_JPY',
  'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'EUR_USD',
  'GBP_AUD', 'GBP_CAD', 'GBP_CHF', 'GBP_JPY', 'GBP_NZD', 'GBP_USD',
  'NZD_CAD', 'NZD_CHF', 'NZD_JPY', 'NZD_USD',
  'USD_CAD', 'USD_CHF', 'USD_JPY',
]);

const ATR_PERIOD = 20;
const M15_PER_H1 = 4;
const MIN_H1_HISTORY = 24;      // ATR20 + a little
const MIN_15M_HISTORY = 24;

// Timezones (fixed EAT analytical window; London by IANA for DST correctness).
const EAT_TZ = 'Africa/Dar_es_Salaam';
const LONDON_TZ = 'Europe/London';
const SESSION_START_HOUR = 17;  // 17:00 EAT
const SESSION_END_HOUR = 23;    // 23:00 EAT
const LONDON_OPEN_HOUR = 8;     // 08:00 Europe/London

const WINDOWS = Object.freeze(['H1', 'M15', 'REFERENCE_SESSION', 'ASIA_TO_DATE', 'LONDON_TO_DATE', 'DAY_TO_DATE']);

// Movement-score → state bands (score is signed, −100..+100).
const STATES = Object.freeze({
  STRONG_UP: 'STRONG_UP', UP: 'UP', NEUTRAL: 'NEUTRAL', DOWN: 'DOWN', STRONG_DOWN: 'STRONG_DOWN',
  // 15M-derived micro states — never override the H1 state.
  MICRO_ACCELERATING: 'MICRO_ACCELERATING', MICRO_DECELERATING: 'MICRO_DECELERATING',
});
function stateForScore(score) {
  if (score >= 60) return STATES.STRONG_UP;
  if (score >= 20) return STATES.UP;
  if (score > -20) return STATES.NEUTRAL;
  if (score > -60) return STATES.DOWN;
  return STATES.STRONG_DOWN;
}

// Movement-quality component weights.
const WEIGHTS = Object.freeze({ magnitude: 0.35, breadth: 0.25, efficiency: 0.15, persistence: 0.15, acceleration: 0.10 });
// Blend of macro (H1) and micro (15M) acceleration.
const ACCEL_BLEND = Object.freeze({ h1: 0.7, m15: 0.3 });
// Magnitude normalisation: a log-return of this size maps to full (1.0) magnitude.
const MAGNITUDE_FULL_SCALE = 0.0040;   // ~40 bps of net currency movement

module.exports = {
  ENGINE_KEY, ENGINE_VERSION, HOUR_MS, M15_MS, CURRENCIES, PAIRS,
  ATR_PERIOD, M15_PER_H1, MIN_H1_HISTORY, MIN_15M_HISTORY,
  EAT_TZ, LONDON_TZ, SESSION_START_HOUR, SESSION_END_HOUR, LONDON_OPEN_HOUR,
  WINDOWS, STATES, stateForScore, WEIGHTS, ACCEL_BLEND, MAGNITUDE_FULL_SCALE,
};
