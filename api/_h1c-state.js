'use strict';

/**
 * NervaFX H1 Continuation Engine — H1-only continuation state machine.
 *
 * Pattern recognition only — these are analytical states, NOT entries. Evaluated
 * as of `searchEndIdx` (the last COMPLETED candle); a forming candle can never
 * change state. Lifecycle:
 *   SEARCHING → IMPULSE_LOCKED → PULLBACK_FORMING → PULLBACK_VALID →
 *   CONTINUATION_READY → SECOND_PUSH_STARTED → CONTINUATION_CONFIRMED
 *   (+ INVALIDATED / EXPIRED)
 */

const { detectReferenceImpulse, rollingAtr } = require('./_h1c-impulse');
const { analyzePullback } = require('./_h1c-pullback');
const { detectTwoCandleFailure, CONFIRM_BUFFER_ATR } = require('./_h1c-failure');
const { clamp } = require('./_h1c-math');
const {
  ATR_PERIOD, STATES, INVALIDATION, OUTCOME,
  PULLBACK_MIN_VALID, PULLBACK_MAX_VALID, SPEED_MAX,
} = require('./_h1c-constants');

const READY_ACTIVE_CANDLES = 3;   // a READY setup stays active for 3 more completed candles.

/** Setup Score at READY+: 35% impulse + 40% pullback + 25% failure. */
function scoreSetup(reference, pb, failure) {
  const impulseQ = reference.quality || 0;
  const speedScore = clamp(1 - (pb.speedRatio || 0) / SPEED_MAX, 0, 1);
  const shapeScore = clamp(Math.max(pb.efficiency || 0, pb.overlap || 0), 0, 1);
  const pullbackQ = Math.round(100 * (0.5 * speedScore + 0.5 * shapeScore));
  const failureQ = failure ? (failure.quality || 0) : 0;
  const score = Math.round(0.35 * impulseQ + 0.40 * pullbackQ + 0.25 * failureQ);
  const grade = score >= 85 ? 'A-GRADE' : score >= 75 ? 'VALID' : score >= 65 ? 'WATCH' : 'LOW_QUALITY';
  return { score, grade, impulseQuality: impulseQ, pullbackQuality: pullbackQ, failureQuality: failureQ };
}

function result(state, extra = {}) {
  return Object.assign({ state, invalidation: null, outcome: null, reference: null }, extra);
}

/**
 * @param {Array} candles  ascending closed H1 candles (from sanitizeH1).
 * @param {{searchEndIdx?:number, reference?:Object}} [opts]
 */
function evaluateSetup(candles, opts = {}) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const searchEndIdx = opts.searchEndIdx != null ? Math.min(opts.searchEndIdx, n - 1) : n - 1;

  const pb = analyzePullback(candles, { searchEndIdx, reference: opts.reference });
  if (!pb.reference) return result(STATES.SEARCHING, { reasons: ['NO_REFERENCE'] });
  const reference = pb.reference;
  const dir = reference.direction;

  const pbDetail = pb.state === STATES.IMPULSE_LOCKED ? null : {
    count: pb.count, type: pullbackType(pb),
    retracePct: pb.retracePct, speedRatio: pb.speedRatio,
    efficiency: pb.efficiency, overlap: pb.overlap,
    high: pb.high, low: pb.low, gaps: pb.gaps,
  };

  if (pb.state === STATES.IMPULSE_LOCKED) return result(STATES.IMPULSE_LOCKED, { reference });
  if (pb.state === STATES.PULLBACK_FORMING) return result(STATES.PULLBACK_FORMING, { reference, count: pb.count, pullback: pbDetail });
  if (pb.state === STATES.INVALIDATED) {
    return result(STATES.INVALIDATED, { reference, invalidation: pb.invalidation || null, outcome: pb.outcome || null, count: pb.count, pullback: pbDetail });
  }

  // pb.state is PULLBACK_VALID or EXPIRED → the pullback reached >= 6 candles.
  // Scan the window for the first valid two-candle failure, then track progression.
  const atrAt = rollingAtr(candles, ATR_PERIOD);
  const pbStart = pb.pullbackStartIdx;
  const atrOf = (i) => atrAt[i] || reference.atr;

  let readyIdx = null, failure = null;
  let secondPushIdx = null, confirmedIdx = null, invalidation = null;

  for (let i = pbStart; i <= searchEndIdx; i++) {
    const c = candles[i];

    // Structural invalidation applies in every phase — a CLOSE beyond the origin.
    if ((dir > 0 && c.close < reference.low) || (dir < 0 && c.close > reference.high)) {
      invalidation = INVALIDATION.STRUCTURE_BREAK; break;
    }

    if (readyIdx === null) {
      const count = i - pbStart + 1;
      if (count > PULLBACK_MAX_VALID) { invalidation = INVALIDATION.EXPIRED_NO_CONTINUATION; break; }
      if (count >= PULLBACK_MIN_VALID) {
        const f = detectTwoCandleFailure(candles.slice(pbStart, i + 1), reference, atrOf(i));
        if (f.valid) { readyIdx = i; failure = f; }
      }
    } else {
      const atr = atrOf(i);
      // CONTINUATION_CONFIRMED — close beyond the reference extreme + buffer.
      if ((dir > 0 && c.close > reference.high + CONFIRM_BUFFER_ATR * atr) ||
          (dir < 0 && c.close < reference.low - CONFIRM_BUFFER_ATR * atr)) {
        confirmedIdx = i; break;
      }
      // SECOND_PUSH_STARTED — close beyond the failure box + buffer.
      if (secondPushIdx === null &&
          ((dir > 0 && c.close > failure.failureBoxHigh + CONFIRM_BUFFER_ATR * atr) ||
           (dir < 0 && c.close < failure.failureBoxLow - CONFIRM_BUFFER_ATR * atr))) {
        secondPushIdx = i;
      }
      // READY stays active for 3 more candles; beyond that with no progression → EXPIRED.
      if ((i - readyIdx) > READY_ACTIVE_CANDLES && secondPushIdx === null && confirmedIdx === null) {
        invalidation = INVALIDATION.EXPIRED_NO_CONTINUATION; break;
      }
    }
  }

  if (invalidation === INVALIDATION.STRUCTURE_BREAK) return result(STATES.INVALIDATED, { reference, invalidation, pullback: pbDetail });
  if (invalidation === INVALIDATION.EXPIRED_NO_CONTINUATION) return result(STATES.EXPIRED, { reference, invalidation, pullback: pbDetail });

  if (readyIdx === null) {
    return result(STATES.PULLBACK_VALID, { reference, count: pb.count, pullback: pbDetail });
  }

  const scored = scoreSetup(reference, pb, failure);
  let state;
  if (confirmedIdx !== null) state = STATES.CONTINUATION_CONFIRMED;
  else if (secondPushIdx !== null) state = STATES.SECOND_PUSH_STARTED;
  else state = STATES.CONTINUATION_READY;

  return result(state, {
    reference,
    pullback: pbDetail,
    failure: { type: failure.type, failureBoxHigh: failure.failureBoxHigh, failureBoxLow: failure.failureBoxLow, quality: failure.quality },
    readyTime: candles[readyIdx].time,
    readyIdx,
    secondPushIdx,
    confirmedIdx,
    pullbackCount: readyIdx - pbStart + 1,
    setupScore: scored.score,
    grade: scored.grade,
    scoreParts: scored,
  });
}

/** Classify the pullback shape for display: sloped / sideways / mixed. */
function pullbackType(pb) {
  const eff = pb.efficiency || 0, ov = pb.overlap || 0;
  if (eff >= 0.6 && ov < 0.5) return 'sloped';
  if (ov >= 0.6 && eff < 0.5) return 'sideways';
  return 'mixed';
}

module.exports = { evaluateSetup, scoreSetup };
