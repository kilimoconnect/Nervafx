'use strict';

/**
 * NervaFX H1 Continuation Engine — pullback lifecycle + reference management.
 *
 * Given a reference impulse (detected or supplied), walk the completed H1
 * candles that follow it and classify the pullback. H1 only, closed candles
 * only, no lookahead (bounded by searchEndIdx). Terminal-failure / continuation
 * logic is deliberately NOT here — it arrives in a later portion.
 */

const { detectReferenceImpulse } = require('./_h1c-impulse');
const { safeDivide, clamp, directionalEfficiency } = require('./_h1c-math');
const {
  HOUR_MS, STATES, INVALIDATION, OUTCOME,
  PROVISIONAL_WINDOW, PULLBACK_MIN_VALID, PULLBACK_MAX_VALID, SPEED_MAX,
} = require('./_h1c-constants');

/** Cumulative pullback/impulse speed ratio at the latest pullback close. */
function speedRatioOf(reference, latestClose, count) {
  const pullbackSpeed = safeDivide(Math.abs(reference.endPrice - latestClose), count, 0);
  const impulseSpeed = safeDivide(reference.netMove, reference.candleCount, 0);
  return safeDivide(pullbackSpeed, impulseSpeed, 0);
}

/** Average overlap fraction between consecutive candles (sideways-ness measure). */
function avgOverlap(cands) {
  if (!cands || cands.length < 2) return 0;
  let sum = 0, cnt = 0;
  for (let i = 1; i < cands.length; i++) {
    const a = cands[i - 1], b = cands[i];
    const ov = Math.max(0, Math.min(a.high, b.high) - Math.max(a.low, b.low));
    const avgRange = ((a.high - a.low) + (b.high - b.low)) / 2;
    sum += safeDivide(ov, avgRange, 0);
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/** Build the snapshot for whatever candle the walk stopped on. */
function buildResult(reference, state, info, candles) {
  const { startIdx, count, pbHigh, pbLow, stopIdx, invalidation = null, outcome = null, gaps = 0 } = info;
  const dir = reference.direction;
  const pbCands = candles.slice(startIdx, stopIdx + 1);
  const latestClose = candles[stopIdx].close;
  const span = reference.high - reference.low;
  const retraceFrac = dir > 0
    ? clamp(safeDivide(reference.high - latestClose, span, 0), 0, 2)
    : clamp(safeDivide(latestClose - reference.low, span, 0), 0, 2);
  const distance = dir > 0 ? latestClose - reference.low : reference.high - latestClose;
  const live = state === STATES.PULLBACK_FORMING || state === STATES.PULLBACK_VALID || state === STATES.IMPULSE_LOCKED;

  return {
    ok: live && !invalidation && !outcome,
    state,
    invalidation,
    outcome,
    reference,
    direction: dir,
    pullbackStartIdx: startIdx,
    pullbackStartTime: candles[startIdx] ? candles[startIdx].time : reference.endTime,
    count,
    high: pbHigh === -Infinity ? null : pbHigh,
    low: pbLow === Infinity ? null : pbLow,
    retracePct: +(retraceFrac * 100).toFixed(2),
    speedRatio: +speedRatioOf(reference, latestClose, count || 1).toFixed(4),
    efficiency: +directionalEfficiency(pbCands).toFixed(4),
    overlap: +avgOverlap(pbCands).toFixed(4),
    distanceToInvalidation: distance,
    distanceToInvalidationAtr: +safeDivide(distance, reference.atr, 0).toFixed(4),
    gaps,
    reasons: [state, invalidation, outcome].filter(Boolean),
  };
}

/**
 * Analyze the pullback that follows the reference impulse.
 *
 * @param {Array} candles  ascending closed H1 candles.
 * @param {{reference?:Object, searchEndIdx?:number}} [opts]
 * @returns {Object}
 */
function analyzePullback(candles, opts = {}) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const searchEndIdx = opts.searchEndIdx != null ? Math.min(opts.searchEndIdx, n - 1) : n - 1;
  let reference = opts.reference || detectReferenceImpulse(candles, { searchEndIdx });
  if (!reference) return { ok: false, state: null, invalidation: null, outcome: null, reference: null, reasons: ['NO_REFERENCE'] };

  // The reference may be replaced (newer same-direction impulse) which resets
  // the pullback — hence the restart loop.
  while (true) {
    const dir = reference.direction;
    const originLow = reference.low, originHigh = reference.high;
    const extreme = dir > 0 ? reference.high : reference.low;
    const firstIdx = reference.endIdx + 1;

    if (firstIdx > searchEndIdx) {
      // Impulse just closed; no pullback candle yet.
      return buildResult(reference, STATES.IMPULSE_LOCKED,
        { startIdx: reference.endIdx, count: 0, pbHigh: reference.high, pbLow: reference.low, stopIdx: reference.endIdx }, candles);
    }

    let localStart = firstIdx, count = 0, pbHigh = -Infinity, pbLow = Infinity, gaps = 0;
    let terminal = null;   // {state, info} | 'restart'

    for (let i = firstIdx; i <= searchEndIdx; i++) {
      const c = candles[i];

      // Missing-candle handling: a gap breaks the consecutive-H1 requirement, so
      // the pullback count restarts after the gap.
      if (i > localStart && (c.ms - candles[i - 1].ms) > HOUR_MS) {
        gaps++; localStart = i; count = 0; pbHigh = -Infinity; pbLow = Infinity;
      }

      count++;
      pbHigh = Math.max(pbHigh, c.high);
      pbLow = Math.min(pbLow, c.low);
      const info = { startIdx: localStart, count, pbHigh, pbLow, stopIdx: i, gaps };

      // 1) Structural invalidation — a CLOSE beyond the origin extreme (a wick is fine).
      if ((dir > 0 && c.close < originLow) || (dir < 0 && c.close > originHigh)) {
        terminal = buildResult(reference, STATES.INVALIDATED, { ...info, invalidation: INVALIDATION.STRUCTURE_BREAK }, candles);
        break;
      }

      // 2) Reference management while provisional (candles 1–5): a newer valid
      // same-direction impulse REPLACES the reference (reset), a valid opposite
      // impulse INVALIDATES. Checked before "early continuation" so a fresh
      // impulse is never mislabelled.
      if (count <= PROVISIONAL_WINDOW) {
        const newRef = detectReferenceImpulse(candles, { searchEndIdx: i });
        if (newRef && newRef.endIdx > reference.endIdx) {
          if (newRef.direction === dir) { reference = newRef; terminal = 'restart'; break; }
          terminal = buildResult(reference, STATES.INVALIDATED, { ...info, invalidation: INVALIDATION.OPPOSITE_IMPULSE }, candles);
          break;
        }
      }

      // 3) Early continuation — a close beyond the extreme before candle 6.
      if (count < PULLBACK_MIN_VALID && ((dir > 0 && c.close > extreme) || (dir < 0 && c.close < extreme))) {
        terminal = buildResult(reference, STATES.INVALIDATED, { ...info, outcome: OUTCOME.EARLY_CONTINUATION }, candles);
        break;
      }

      // 4) Speed ratio — too fast a pullback signals a possible reversal.
      if (speedRatioOf(reference, c.close, count) > SPEED_MAX) {
        terminal = buildResult(reference, STATES.INVALIDATED, { ...info, invalidation: INVALIDATION.SPEED_REVERSAL }, candles);
        break;
      }
    }

    if (terminal === 'restart') continue;   // reference replaced → re-walk
    if (terminal) return terminal;

    // Reached the evaluation point with a live pullback → classify by count.
    let state;
    if (count <= PROVISIONAL_WINDOW) state = STATES.PULLBACK_FORMING;
    else if (count <= PULLBACK_MAX_VALID) state = STATES.PULLBACK_VALID;
    else state = STATES.EXPIRED;
    return buildResult(reference, state,
      { startIdx: localStart, count, pbHigh, pbLow, stopIdx: searchEndIdx, gaps }, candles);
  }
}

module.exports = { analyzePullback, speedRatioOf, avgOverlap };
