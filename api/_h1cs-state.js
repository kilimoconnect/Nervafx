'use strict';

/**
 * NervaFX H1 Continuation Engine — SESSION state machine (isolated).
 *
 * Late NY reference move (17:00–23:00 EAT) → Asia pause/pullback → failure →
 * second push (Asia or London). Pattern recognition only — no entries.
 *
 * Monotonic per stable setup: a forward scan over the post-session candles
 * upgrades state and never regresses (CONFIRMED never falls back to PULLBACK).
 * No 6–12 candle window and no 12-candle expiry — the setup lives by session
 * boundaries. Failure is a CONDITION; the second push may start on the SAME
 * candle that confirms the failure. Evaluated only on completed candles ≤ evalMs.
 */

const { atr, safeDivide, clamp, candleBody, candleDirection, directionalCloseLocation } = require('./_h1c-math');
const S = require('./_h1cs-session');
const {
  HOUR_MS, MODE, STATES, FAILURE_STATUS, PHASE, PAUSE_TYPE, INVALIDATION, REJECTIONS,
  SESSION_ATR_PERIOD, RETRACE_PAUSE_MAX, RETRACE_CONTROLLED_MAX,
  FAILURE_EXTENSION_BUFFER_ATR, CONFIRM_BUFFER_ATR, CONTINUATION_FORCE_ATR,
  ENGINE_VERSION, CONFIGURATION_VERSION,
} = require('./_h1cs-constants');

const r3 = (v) => Math.round(v * 1000) / 1000;

/** Two-candle failure adapted for the post-session pullback (isolated thresholds). */
function sessionFailure(seg, dir, atrValue) {
  if (seg.length < 2 || !atrValue) return { status: FAILURE_STATUS.NONE };
  const A = seg[seg.length - 2];
  const B = seg[seg.length - 1];
  const prior = seg.slice(0, -1);
  const priorLow = Math.min.apply(null, prior.map((c) => c.low));
  const priorHigh = Math.max.apply(null, prior.map((c) => c.high));
  const buf = FAILURE_EXTENSION_BUFFER_ATR * atrValue;

  let noNewExtreme, betterClose, penetration;
  if (dir > 0) { // sellers failing to extend below
    noNewExtreme = B.low >= priorLow - buf;
    betterClose = B.close > A.close;
    penetration = Math.max(0, priorLow - B.low);
  } else {       // buyers failing to extend above
    noNewExtreme = B.high <= priorHigh + buf;
    betterClose = B.close < A.close;
    penetration = Math.max(0, B.high - priorHigh);
  }
  const closeLoc = directionalCloseLocation(B, dir);

  let status;
  if (noNewExtreme && betterClose && closeLoc >= 0.5) status = FAILURE_STATUS.CONFIRMED;
  else if (noNewExtreme || betterClose) status = FAILURE_STATUS.DEVELOPING;
  else status = FAILURE_STATUS.NONE;

  const boxHigh = Math.max(A.high, B.high);
  const boxLow = Math.min(A.low, B.low);
  const confirmationLevel = dir > 0 ? boxHigh + CONFIRM_BUFFER_ATR * atrValue : boxLow - CONFIRM_BUFFER_ATR * atrValue;
  const quality = Math.round(100 * (
    0.40 * clamp(1 - safeDivide(penetration, buf, 0), 0, 1) +
    0.30 * clamp(closeLoc, 0, 1) +
    0.30 * (betterClose ? 1 : 0)));
  const reasonCodes = [];
  if (noNewExtreme) reasonCodes.push('NO_NEW_EXTREME');
  if (betterClose) reasonCodes.push(dir > 0 ? 'HIGHER_CLOSE' : 'LOWER_CLOSE');
  if (closeLoc >= 0.5) reasonCodes.push('CLOSE_REJECTION');

  return { status, confirmationLevel, boxHigh, boxLow, failureExtensionATR: r3(safeDivide(penetration, atrValue, 0)), quality, A, B, reasonCodes };
}

function sessionScore(ref, fail) {
  const moveScore = clamp((ref.sessionMoveATR || 0) / 2, 0, 1);
  const effScore = clamp(ref.sessionEfficiency || 0, 0, 1);
  const closeScore = clamp(ref.sessionCloseQuality || 0, 0, 1);
  const failScore = fail ? clamp((fail.quality || 0) / 100, 0, 1) : 0;
  return Math.round(100 * (0.35 * moveScore + 0.25 * effScore + 0.20 * closeScore + 0.20 * failScore));
}
function gradeOf(score) { return score >= 85 ? 'A-GRADE' : score >= 75 ? 'VALID' : score >= 65 ? 'WATCH' : 'LOW_QUALITY'; }

/**
 * @param {Array} candles sanitized closed H1 candles (ascending, with .ms/.time)
 * @param {{evalMs?:number}} [opts]
 */
function evaluateSessionSetup(candles, opts) {
  opts = opts || {};
  const n = candles.length;
  const evalMs = opts.evalMs != null ? opts.evalMs : (n ? candles[n - 1].ms + HOUR_MS : Date.now());
  const res = {
    mode: MODE, state: STATES.SEARCHING_REFERENCE_SESSION, direction: null, reference: null,
    failureStatus: FAILURE_STATUS.NONE, invalidationCode: null, reasonCodes: [],
    engineVersion: ENGINE_VERSION, configurationVersion: CONFIGURATION_VERSION,
    evaluatedAt: new Date(evalMs).toISOString(),
  };

  const act = S.activeReferenceSessionDate(evalMs);
  if (act.forming) { res.reasonCodes.push('SESSION_FORMING'); return res; }
  const dateStr = act.date;
  if (S.weekdayOf(dateStr) === 5) { res.reasonCodes.push(REJECTIONS.FRIDAY_NO_CONTINUATION); return res; }

  const { startUtc, endUtc } = S.sessionWindowUtc(dateStr);
  if (endUtc > evalMs) { res.reasonCodes.push('SESSION_NOT_CLOSED'); return res; }

  const atr20 = S.sessionAtr(candles, startUtc);
  if (!atr20) { res.reasonCodes.push('INSUFFICIENT_ATR'); return res; }

  const ref = S.buildReferenceSession(candles, startUtc);
  if (!ref.ok) { res.reasonCodes.push(ref.reason); return res; }

  const qual = S.qualifyReference(ref.six, ref.synthetic, atr20);
  const refObj = {
    date: dateStr,
    startUtc: new Date(startUtc).toISOString(), endUtc: new Date(endUtc).toISOString(),
    open: ref.synthetic.open, high: ref.synthetic.high, low: ref.synthetic.low, close: ref.synthetic.close,
    atr20: r3(atr20),
    sessionMove: qual.sessionMove, sessionMoveATR: qual.sessionMoveATR, sessionEfficiency: qual.sessionEfficiency,
    directionalCandleCount: qual.directionalCandleCount, sessionCloseQuality: qual.sessionCloseQuality,
  };
  res.reference = refObj;

  if (!qual.qualified) { res.reasonCodes = qual.failedConditions.slice(); return res; }
  const dir = qual.direction;
  res.direction = dir > 0 ? 'BUY' : 'SELL';
  res.referenceSessionEndUtc = refObj.endUtc;
  res.setupId = MODE + ':' + (opts.instrument || '') + ':' + res.direction + ':' + refObj.endUtc;
  res.state = STATES.REFERENCE_SESSION_LOCKED;

  const expiryUtc = startUtc + 24 * HOUR_MS; // 17:00 EAT the following day
  res.expiresAt = new Date(expiryUtc).toISOString();
  if (evalMs >= expiryUtc) { res.state = STATES.EXPIRED; res.invalidationCode = INVALIDATION.EXPIRED_NO_CONTINUATION; return res; }

  const post = candles.filter((c) => c.ms >= endUtc && (c.ms + HOUR_MS) <= evalMs);
  res.postSessionCandleCount = post.length;
  const londonOpen = S.londonOpenForCycle(endUtc);
  res.londonOpenUtc = new Date(londonOpen).toISOString();
  const phaseOfC = (c) => (c.ms < londonOpen ? PHASE.ASIA : PHASE.LONDON);

  function retracement(seg) {
    if (!seg.length) return 0;
    if (dir > 0) { const lo = Math.min.apply(null, seg.map((c) => c.low)); return safeDivide(refObj.high - lo, refObj.high - refObj.open, 0); }
    const hi = Math.max.apply(null, seg.map((c) => c.high)); return safeDivide(hi - refObj.low, refObj.open - refObj.low, 0);
  }

  // ── forward scan (monotonic) ────────────────────────────────────────────────
  let state = STATES.REFERENCE_SESSION_LOCKED;
  let failureStatus = FAILURE_STATUS.NONE, failureMeta = null;
  let failureLevel = null;   // frozen once failure first confirms (does not slide with new candles)
  let secondPushStartedAt = null, secondPushPhase = null, confirmationAt = null, confirmationPhase = null, invalidation = null;
  let pullbackExtreme = dir > 0 ? refObj.high : refObj.low;

  for (let i = 0; i < post.length; i++) {
    const c = post[i];
    pullbackExtreme = dir > 0 ? Math.min(pullbackExtreme, c.low) : Math.max(pullbackExtreme, c.high);

    // Continuation confirmed — close beyond the reference-session extreme (terminal, monotonic).
    const brokeExtreme = dir > 0 ? c.close > refObj.high : c.close < refObj.low;
    if (brokeExtreme) {
      if (!secondPushStartedAt) { secondPushStartedAt = c.time; secondPushPhase = phaseOfC(c); }
      confirmationAt = c.time; confirmationPhase = phaseOfC(c); state = STATES.SESSION_CONTINUATION_CONFIRMED;
      continue;
    }
    if (state === STATES.SESSION_CONTINUATION_CONFIRMED) continue;

    // Structural invalidation — completed close beyond the reference origin (before any push).
    const brokeOrigin = dir > 0 ? c.close < refObj.low : c.close > refObj.high;
    if (brokeOrigin && !secondPushStartedAt) { invalidation = INVALIDATION.STRUCTURE_BREAK; state = STATES.INVALIDATED; break; }

    if (i >= 1) {
      const fail = sessionFailure(post.slice(0, i + 1), dir, atr20);
      // Freeze the confirmation level the first time failure confirms.
      if (fail.status === FAILURE_STATUS.CONFIRMED && failureLevel == null) {
        failureLevel = fail.confirmationLevel; failureMeta = fail; failureStatus = FAILURE_STATUS.CONFIRMED;
      } else if (failureLevel == null) {
        failureStatus = fail.status; if (fail.status !== FAILURE_STATUS.NONE) failureMeta = fail;
      }

      if (failureLevel != null && !secondPushStartedAt) {
        // Second push = an energetic close beyond the FROZEN failure level (may be this candle or a later one).
        const breaks = dir > 0 ? c.close > failureLevel : c.close < failureLevel;
        const force = candleBody(c) >= CONTINUATION_FORCE_ATR * atr20 && (dir > 0 ? candleDirection(c) > 0 : candleDirection(c) < 0);
        if (breaks && force) { secondPushStartedAt = c.time; secondPushPhase = phaseOfC(c); state = STATES.SECOND_PUSH_STARTED; }
        else { state = STATES.SECOND_PUSH_READY; }
      } else if (failureLevel == null && !secondPushStartedAt) {
        const rp = retracement(post.slice(0, i + 1));
        state = rp < RETRACE_PAUSE_MAX ? STATES.POST_SESSION_PAUSE : STATES.POST_SESSION_PULLBACK;
      }
    }
  }

  const retr = retracement(post);
  const pauseType = retr < RETRACE_PAUSE_MAX ? PAUSE_TYPE.PAUSE : retr <= RETRACE_CONTROLLED_MAX ? PAUSE_TYPE.CONTROLLED_PULLBACK : PAUSE_TYPE.DEEP_PULLBACK;
  if (!secondPushStartedAt && !invalidation && state !== STATES.SESSION_CONTINUATION_CONFIRMED && pauseType === PAUSE_TYPE.DEEP_PULLBACK) {
    invalidation = INVALIDATION.DEEP_PULLBACK; state = STATES.INVALIDATED;
  }

  res.state = state;
  res.failureStatus = failureStatus;
  res.invalidationCode = invalidation;
  res.retracementPct = Math.round(retr * 1000) / 10;
  res.pausePullbackType = pauseType;
  res.pullbackExtreme = pullbackExtreme;
  res.secondPushStartedAt = secondPushStartedAt;
  res.secondPushStartPhase = secondPushPhase;
  res.continuationConfirmedAt = confirmationAt;
  res.confirmationPhase = confirmationPhase;
  if (failureMeta) {
    res.failureCandleTimes = [failureMeta.A.time, failureMeta.B.time];
    res.failureExtensionATR = failureMeta.failureExtensionATR;
    res.failureQuality = failureMeta.quality;
    res.failureReasonCodes = failureMeta.reasonCodes || [];
    res.confirmationLevel = failureMeta.confirmationLevel;
  }
  res.invalidationLevel = dir > 0 ? refObj.low : refObj.high;
  res.score = sessionScore(refObj, failureMeta);
  res.grade = gradeOf(res.score);
  return res;
}

module.exports = { evaluateSessionSetup, sessionFailure, sessionScore, gradeOf };
