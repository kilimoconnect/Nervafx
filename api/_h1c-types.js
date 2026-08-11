'use strict';

/**
 * NervaFX H1 Continuation Engine — domain type definitions.
 *
 * CommonJS has no static types, so shapes are documented as JSDoc @typedefs for
 * editor tooling and human readers. There is no runtime behaviour here. Fields
 * marked "(finalized later)" will be firmed up when the impulse/pullback
 * detectors and state machine land in their portions.
 *
 * @typedef {1|-1} Direction  +1 = BUY / up, -1 = SELL / down.
 *
 * @typedef {Object} H1Candle
 * @property {string} time   ISO-8601 open timestamp (UTC), preserved as stored.
 * @property {number} ms     open time in epoch milliseconds.
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 *
 * @typedef {Object} ImpulseCandidate
 * @property {number} startIdx     index of the impulse's first candle.
 * @property {number} endIdx       index of the impulse's last candle.
 * @property {Direction} direction
 * @property {number} sizeAtr      ATR-normalized displacement of the impulse.
 * @property {number} extreme      high (BUY) / low (SELL) of the impulse.
 * // (finalized when the impulse detector lands)
 *
 * @typedef {Object} ReferenceImpulse
 * @property {Direction} direction
 * @property {number} startIdx
 * @property {number} endIdx
 * @property {number} extreme      the reference extreme to break for continuation.
 * @property {number} sizeAtr
 * // The LATEST completed impulse immediately before the pullback. Earlier
 * // aligned impulses are kept only as context, never merged into this.
 *
 * @typedef {Object} PullbackSnapshot
 * @property {number} startIdx
 * @property {number} endIdx
 * @property {number} lengthBars   completed H1 candles in the pullback (6–12).
 * @property {number} retraceFrac  retrace of the reference impulse, [0,1].
 * @property {number} efficiency   directional efficiency of the pullback leg.
 * // (finalized when the pullback detector lands)
 *
 * @typedef {Object} TwoCandleFailure
 * @property {boolean} failing     true when the last two pullback candles show
 *                                 countertrend progress failing.
 * @property {number} [aIdx]
 * @property {number} [bIdx]
 *
 * @typedef {Object} StateTransition
 * @property {string} from
 * @property {string} to
 * @property {string} reason       a REASONS.* or INVALIDATION.* code.
 * @property {string} at           candle time the transition was decided on.
 *
 * @typedef {Object} ContinuationSetup
 * @property {string} instrument
 * @property {string} state                 a STATES.* value.
 * @property {Direction} [direction]
 * @property {ReferenceImpulse} [impulse]
 * @property {PullbackSnapshot} [pullback]
 * @property {StateTransition[]} history
 * @property {string|null} [invalidation]   an INVALIDATION.* code if killed.
 * @property {string} [asOf]                evaluation time (ISO).
 *
 * @typedef {Object} ScanResult
 * @property {string} generatedAt
 * @property {ContinuationSetup[]} setups
 * @property {Object} meta                  per-scan diagnostics (rejections, gaps…).
 */

module.exports = {};
