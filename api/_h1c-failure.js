'use strict';

/**
 * NervaFX H1 Continuation Engine — final-two-H1-candle failure detector.
 *
 * Pattern recognition only (no entries). Evaluated once the pullback holds
 * 6–12 completed H1 candles. Candle A = penultimate, Candle B = latest. All
 * thresholds are ATR-normalized; the caller supplies the ATR(20) value.
 */

const { clamp, directionalCloseLocation, safeDivide } = require('./_h1c-math');

const NEAR_EXTREME_ATR = 0.25;   // A/B must be within this of the pullback extreme.
const STALL_SLIP_ATR = 0.10;     // stall: B may slip at most this beyond A.
const SWEEP_PEN_ATR = 0.20;      // sweep: max penetration beyond A before reclaim.
const CONFIRM_BUFFER_ATR = 0.05; // (exported for the state machine's break buffers.)

/**
 * @param {Array} pbCands   the pullback candles (>= 2), ascending.
 * @param {Object} reference the reference impulse (direction, high, low).
 * @param {number} atr       ATR(20) value for normalization.
 * @returns {{valid:boolean, type?:string, failureBoxHigh?:number, failureBoxLow?:number, quality?:number, reason?:string}}
 */
function detectTwoCandleFailure(pbCands, reference, atr) {
  if (!pbCands || pbCands.length < 2 || !atr || atr <= 0) return { valid: false, reason: 'INSUFFICIENT' };
  const dir = reference.direction;
  const A = pbCands[pbCands.length - 2];
  const B = pbCands[pbCands.length - 1];

  let pbLow = Infinity, pbHigh = -Infinity;
  for (const c of pbCands) { pbLow = Math.min(pbLow, c.low); pbHigh = Math.max(pbHigh, c.high); }

  // The pair must sit near the pullback extreme.
  const pairExtreme = dir > 0 ? Math.min(A.low, B.low) : Math.max(A.high, B.high);
  const pbExtreme = dir > 0 ? pbLow : pbHigh;
  if (Math.abs(pairExtreme - pbExtreme) > NEAR_EXTREME_ATR * atr) {
    return { valid: false, reason: 'PAIR_NOT_AT_EXTREME' };
  }

  let type = null;
  let penetration = 0;
  if (dir > 0) {
    const stall = (B.low >= A.low - STALL_SLIP_ATR * atr) && (B.close > A.close) && (B.close > reference.low);
    const sweep = (B.low < A.low) && ((A.low - B.low) <= SWEEP_PEN_ATR * atr) &&
      (B.close > A.low) && (B.close > A.close) && (B.close > reference.low);
    if (sweep) { type = 'BUY_SWEEP'; penetration = A.low - B.low; }
    else if (stall) { type = 'BUY_STALL'; penetration = Math.max(0, A.low - B.low); }
  } else {
    const stall = (B.high <= A.high + STALL_SLIP_ATR * atr) && (B.close < A.close) && (B.close < reference.high);
    const sweep = (B.high > A.high) && ((B.high - A.high) <= SWEEP_PEN_ATR * atr) &&
      (B.close < A.high) && (B.close < A.close) && (B.close < reference.high);
    if (sweep) { type = 'SELL_SWEEP'; penetration = B.high - A.high; }
    else if (stall) { type = 'SELL_STALL'; penetration = Math.max(0, B.high - A.high); }
  }
  if (!type) return { valid: false, reason: 'NO_FAILURE' };

  const failureBoxHigh = Math.max(A.high, B.high);
  const failureBoxLow = Math.min(A.low, B.low);

  // Failure Quality: 40% proximity + 30% lack of further extension + 30% reclaim/close strength.
  const proximity = clamp(1 - safeDivide(Math.abs(pairExtreme - pbExtreme), NEAR_EXTREME_ATR * atr, 0), 0, 1);
  const extension = clamp(1 - safeDivide(penetration, SWEEP_PEN_ATR * atr, 0), 0, 1);
  const reclaim = clamp(directionalCloseLocation(B, dir), 0, 1);
  const quality = Math.round(100 * (0.40 * proximity + 0.30 * extension + 0.30 * reclaim));

  return { valid: true, type, failureBoxHigh, failureBoxLow, quality, A, B, pullbackLow: pbLow, pullbackHigh: pbHigh };
}

module.exports = { detectTwoCandleFailure, CONFIRM_BUFFER_ATR };
