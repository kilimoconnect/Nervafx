'use strict';

/**
 * NervaFX H1 Continuation Engine — foundation constants.
 *
 * Fully isolated: this module imports nothing from Sharp Reversal or any other
 * engine. H1-only. Constants here are the foundation (universe, states, reason
 * codes, data sizing); pattern-detection thresholds arrive in a later portion.
 */

const HOUR_MS = 60 * 60 * 1000;

// 28-pair universe in the provider's underscore symbol format (base_quote),
// matching backtest_candles.instrument.
const PAIRS = Object.freeze([
  'AUD_CAD', 'AUD_CHF', 'AUD_JPY', 'AUD_NZD', 'AUD_USD',
  'CAD_CHF', 'CAD_JPY',
  'CHF_JPY',
  'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'EUR_USD',
  'GBP_AUD', 'GBP_CAD', 'GBP_CHF', 'GBP_JPY', 'GBP_NZD', 'GBP_USD',
  'NZD_CAD', 'NZD_CHF', 'NZD_JPY', 'NZD_USD',
  'USD_CAD', 'USD_CHF', 'USD_JPY',
]);

// Continuation state machine. Portion 2 defines the labels only; the transition
// logic lands in a later portion.
const STATES = Object.freeze({
  SEARCHING: 'SEARCHING',
  IMPULSE_LOCKED: 'IMPULSE_LOCKED',
  PULLBACK_FORMING: 'PULLBACK_FORMING',
  PULLBACK_VALID: 'PULLBACK_VALID',
  CONTINUATION_READY: 'CONTINUATION_READY',
  SECOND_PUSH_STARTED: 'SECOND_PUSH_STARTED',
  CONTINUATION_CONFIRMED: 'CONTINUATION_CONFIRMED',
  INVALIDATED: 'INVALIDATED',
  EXPIRED: 'EXPIRED',
});
const STATE_LIST = Object.freeze(Object.values(STATES));

// Reason codes (why a transition/observation happened).
const REASONS = Object.freeze({
  IMPULSE_DETECTED: 'IMPULSE_DETECTED',
  PULLBACK_STARTED: 'PULLBACK_STARTED',
  PULLBACK_QUALIFIED: 'PULLBACK_QUALIFIED',
  TWO_CANDLE_FAILURE: 'TWO_CANDLE_FAILURE',
  SECOND_PUSH: 'SECOND_PUSH',
  BREAK_CONFIRMED: 'BREAK_CONFIRMED',
});

// Invalidation reasons (why a live setup was killed).
const INVALIDATION = Object.freeze({
  PULLBACK_TOO_SHORT: 'PULLBACK_TOO_SHORT',
  PULLBACK_TOO_LONG: 'PULLBACK_TOO_LONG',
  PULLBACK_TOO_DEEP: 'PULLBACK_TOO_DEEP',
  STRUCTURE_BREAK: 'STRUCTURE_BREAK',        // close beyond the reference impulse origin extreme.
  SPEED_REVERSAL: 'SPEED_REVERSAL',          // pullback speed ratio > max (possible reversal).
  OPPOSITE_IMPULSE: 'OPPOSITE_IMPULSE',      // a valid opposite impulse formed while provisional.
  OPPOSITE_BREAK: 'OPPOSITE_BREAK',
  SEQUENCE_GAP: 'SEQUENCE_GAP',
  EXPIRED_NO_CONTINUATION: 'EXPIRED_NO_CONTINUATION',
});

// Non-invalidation candidate closures.
const OUTCOME = Object.freeze({
  EARLY_CONTINUATION: 'EARLY_CONTINUATION',  // broke the extreme before 6 pullback candles.
});

// Data-quality rejection reasons.
const DATA_REJECTIONS = Object.freeze({
  NO_DATA: 'NO_DATA',
  DUPLICATE_CANDLE: 'DUPLICATE_CANDLE',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT_HISTORY',
});

// Data / warm-up sizing.
const ATR_PERIOD = 20;            // ATR(20) per the Portion 2 spec.
const FETCH_LIMIT = 300;          // headroom above the 150 minimum.
const MIN_CLOSED_CANDLES = 150;   // reject/flag a pair with fewer closed H1s.

// Pullback lifecycle sizing / thresholds (Portion 4 spec).
const PROVISIONAL_WINDOW = 5;     // pullback candles 1–5: reference is provisional.
const PULLBACK_MIN_VALID = 6;     // 6–12 completed candles = PULLBACK_VALID.
const PULLBACK_MAX_VALID = 12;    // beyond 12 with no terminal failure = EXPIRED.
const SPEED_IDEAL = 0.70;         // ideal pullback/impulse speed ratio.
const SPEED_MAX = 0.85;           // above this invalidates (possible reversal).

module.exports = {
  HOUR_MS,
  PAIRS,
  STATES, STATE_LIST,
  REASONS, INVALIDATION, OUTCOME, DATA_REJECTIONS,
  ATR_PERIOD, FETCH_LIMIT, MIN_CLOSED_CANDLES,
  PROVISIONAL_WINDOW, PULLBACK_MIN_VALID, PULLBACK_MAX_VALID, SPEED_IDEAL, SPEED_MAX,
};
