'use strict';

/**
 * Strict N-N fractal swing detection (initial research definition — see config.js;
 * NOT optimized against returns).
 *
 *   • Swing HIGH at i: high[i] strictly exceeds the highs of the `left` candles
 *     before and the `right` candles after. Equal highs do NOT qualify.
 *   • Swing LOW at i: low[i] strictly undercuts the lows of those surrounding candles.
 *   • CONFIRMATION happens only when the `right`-th following candle CLOSES, so the
 *     pivot becomes knowable at cands[i+right].closeMs — never before.
 *   • The extreme time (the pivot bar) and the confirmation time are stored
 *     separately.
 *   • A candle that qualifies as BOTH a swing high and a swing low (an outside bar
 *     that is the 5-bar extreme on both sides) is flagged `bothSide` and EXCLUDED
 *     from setup sequencing.
 *
 * Causality: a pivot is "known as-of t" only when confirmedAtMs ≤ t. Because every
 * pivot is a pure function of candles up to i+right, appending later candles never
 * changes an already-confirmed pivot — as-of outputs are stable.
 */

function detectFractals(cands, opts = {}) {
  const left = opts.left != null ? opts.left : 2;
  const right = opts.right != null ? opts.right : 2;
  const n = cands.length;
  const pivots = [];
  for (let i = left; i < n - right; i++) {
    const hi = cands[i].high, lo = cands[i].low;
    let isHigh = true, isLow = true;
    for (let k = 1; k <= left && (isHigh || isLow); k++) {
      if (cands[i - k].high >= hi) isHigh = false;
      if (cands[i - k].low <= lo) isLow = false;
    }
    for (let k = 1; k <= right && (isHigh || isLow); k++) {
      if (cands[i + k].high >= hi) isHigh = false;
      if (cands[i + k].low <= lo) isLow = false;
    }
    if (!isHigh && !isLow) continue;
    const confirmedAtMs = cands[i + right].closeMs;
    const base = {
      index: i,
      extremeTimeMs: cands[i].openMs,          // the pivot bar's timestamp
      extremeCloseMs: cands[i].closeMs,
      confirmedAtMs,                            // when the pivot becomes knowable
      confirmLagBars: right,
      bothSide: isHigh && isLow,
    };
    if (isHigh && isLow) {
      // Ambiguous outside-bar extreme: report both, flagged, excluded from sequencing.
      pivots.push(Object.assign({ type: 'HIGH', price: hi }, base));
      pivots.push(Object.assign({ type: 'LOW', price: lo }, base));
    } else if (isHigh) {
      pivots.push(Object.assign({ type: 'HIGH', price: hi }, base));
    } else {
      pivots.push(Object.assign({ type: 'LOW', price: lo }, base));
    }
  }
  return pivots;
}

/** Pivots knowable as-of t (confirmedAtMs ≤ t), chronological by confirmation then bar. */
function confirmedAsOf(pivots, t) {
  return pivots
    .filter((p) => p.confirmedAtMs <= t && !p.bothSide)
    .slice()
    .sort((a, b) => (a.confirmedAtMs - b.confirmedAtMs) || (a.extremeTimeMs - b.extremeTimeMs));
}

/** The last `k` confirmed pivots of a given type, most-recent-first. */
function lastOfType(confirmed, type, k) {
  const arr = confirmed.filter((p) => p.type === type);
  return arr.slice(Math.max(0, arr.length - k)).reverse();
}

module.exports = { detectFractals, confirmedAsOf, lastOfType };
