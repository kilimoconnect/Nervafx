'use strict';

/**
 * NervaFX Liquidity Failure Engine — shared type definitions.
 *
 * No TypeScript in this codebase; these JSDoc typedefs document the shapes that
 * flow between modules and pair with the runtime enums in `_lfe-constants.js`.
 * This module has no runtime behaviour beyond re-exporting the enums for
 * convenient single-import use.
 */

const {
  FAILED_SIDE, DIRECTION, SETUP_TYPE, LEVEL_TYPE, ENGINE_STATE, SIGNAL_CLASS, EVAL_MODE,
} = require('./_lfe-constants');

/**
 * @typedef {Object} Candle
 * @property {number} openMs   candle OPEN time, UTC epoch-ms
 * @property {string} time     original ISO open timestamp
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 */

/**
 * @typedef {Object} EvaluationContext
 * @property {boolean} ok
 * @property {?string} requestedTime       ISO of the raw request (null when latest)
 * @property {number}  evaluationMs        snapped evaluation time, UTC epoch-ms
 * @property {string}  evaluationTimeUtc   ISO of evaluationMs
 * @property {('latest_available'|'historical')} mode
 * @property {string}  displayTimezone
 * @property {string}  commonEarliest
 * @property {string}  commonLatest
 * @property {string}  configurationVersion
 * @property {string}  lastCompletedH1     ISO close of newest usable H1
 * @property {string}  h1UntilIso          inclusive H1 open bound
 * @property {string}  m15UntilIso         inclusive M15 open bound
 */

/**
 * @typedef {Object} Coverage
 * @property {boolean} ok
 * @property {number}  earliestSelectable  UTC epoch-ms (warmup-adjusted)
 * @property {number}  latestAvailable     UTC epoch-ms (M15-snapped)
 * @property {Array<{pair:string,type:string}>} warnings
 */

/**
 * @typedef {Object} LiquidityLevel
 * @property {string} pair
 * @property {('SWING_HIGH'|'SWING_LOW'|'EQUAL_HIGHS'|'EQUAL_LOWS')} levelType
 * @property {number} levelPrice
 * @property {number} zoneLow
 * @property {number} zoneHigh
 * @property {number} formedAtMs   pivot candle open, UTC epoch-ms
 * @property {number} h1Atr
 */

/**
 * @typedef {Object} FailureEvent
 * @property {string} pair
 * @property {('BUYERS'|'SELLERS')} failedSide
 * @property {('BUY'|'SELL')} direction
 * @property {('IMMEDIATE'|'DELAYED')} setupType
 * @property {?number} attackAtMs
 * @property {?number} breakoutAtMs
 * @property {number}  failureAtMs   H1 close of the failure, UTC epoch-ms
 */

/**
 * @typedef {Object} StateTransition
 * @property {string}  signalKey
 * @property {?string} fromState
 * @property {string}  toState
 * @property {?string} reason
 * @property {number}  occurredAtMs      event time driving the transition (UTC)
 * @property {number}  evaluationMs      when the engine observed it (UTC)
 * @property {string}  idempotencyKey
 */

module.exports = {
  FAILED_SIDE, DIRECTION, SETUP_TYPE, LEVEL_TYPE, ENGINE_STATE, SIGNAL_CLASS, EVAL_MODE,
};
