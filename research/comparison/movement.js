'use strict';

/**
 * Movement-QUALITY metrics for a window of a currency-index path (research, DESCRIPTIVE only).
 *
 * Pure array math — no I/O, no DB, no look-ahead beyond the slice it is handed. Operates on a
 * pre-rebased series `xs` (percentage points, pp, relative to the window's FIRST completed close)
 * and the matching close timestamps `times`. The engine (evolution.js) slices the continuous index
 * into windows and calls these; the chart, cards, table and spread analysis all consume the result,
 * so the formulas live in exactly one place.
 *
 * What these describe: observed CLOSE-TO-CLOSE travel of the zero-sum 1/8 basket index. They are
 * NOT buy/sell volume, order flow, participation, probabilities, or any validated predictive value.
 * "Directional balance" is the signed twin of "efficiency" (balance = sign(M)·efficiency when the
 * net direction matches the dominant side) — never treat them as two independent confirmations.
 */

const num = (x, d = 4) => (x == null || !isFinite(x) ? null : +(+x).toFixed(d));

/**
 * @param {number[]} xs    level series in pp, xs[0] === 0 (rebased to the window open).
 * @param {number[]} times close timestamps (ms), same length as xs, ascending.
 * @param {number}   tol   pp tolerance for strengthen/weaken/unchanged and up/down/flat.
 */
function movementMetrics(xs, times, tol = 0.005) {
  if (!xs || xs.length < 2 || !times || times.length !== xs.length) {
    return { ok: false, reason: 'insufficient observations', n: xs ? Math.max(0, xs.length - 1) : 0 };
  }
  const n = xs.length - 1;                      // number of M15 intervals (deltas)
  const x0 = xs[0], xn = xs[n];
  const M = xn - x0;                            // net movement
  const direction = M > tol ? 'strengthening' : (M < -tol ? 'weakening' : 'unchanged');

  // magnitude sums (sign-based, no tolerance) and tolerance-classified interval counts
  let U = 0, D = 0, up = 0, down = 0, flat = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 0) U += d; else if (d < 0) D += -d;
    if (d > tol) up++; else if (d < -tol) down++; else flat++;
  }
  const T = U + D;
  const efficiency = T > 0 ? 100 * Math.abs(M) / T : null;       // close-to-close net survival of travel
  const balance = T > 0 ? 100 * (U - D) / T : null;             // signed share of movement (−100..+100)
  const upwardShare = T > 0 ? 100 * U / T : null;
  const downwardShare = T > 0 ? 100 * D / T : null;

  // excursions on the level series (opposing movement + current giveback)
  let hi = -Infinity, lo = Infinity, hiMs = null, loMs = null;
  let maxDrawdown = 0, maxRebound = 0, runHigh = -Infinity, runLow = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (v > hi) { hi = v; hiMs = times[i]; }
    if (v < lo) { lo = v; loMs = times[i]; }
    if (v > runHigh) runHigh = v;
    if (v < runLow) runLow = v;
    if (runHigh - v > maxDrawdown) maxDrawdown = runHigh - v;    // biggest give-back after a running high
    if (v - runLow > maxRebound) maxRebound = v - runLow;        // biggest rally after a running low
  }
  const R = hi - lo;                             // window range
  const currentFromHigh = hi - xn;
  const currentFromLow = xn - lo;
  const norm = (e) => (R > 0 ? 100 * e / R : null);              // as % of the WINDOW RANGE (not of an impulse)
  const startMs = times[0], endMs = times[n];
  const elapsedHours = (endMs - startMs) / 3600000;
  const pace = elapsedHours > 0 ? M / elapsedHours : null;       // pp per hour

  return {
    ok: true, n,
    x0: num(x0), xn: num(xn), M: num(M), direction, tol,
    U: num(U), D: num(D), T: num(T),
    efficiency: efficiency == null ? null : num(efficiency, 2),
    balance: balance == null ? null : num(balance, 2),
    upwardShare: upwardShare == null ? null : num(upwardShare, 2),
    downwardShare: downwardShare == null ? null : num(downwardShare, 2),
    upIntervals: up, downIntervals: down, flatIntervals: flat,
    upPct: num(100 * up / n, 1), downPct: num(100 * down / n, 1), unchangedPct: num(100 * flat / n, 1),
    high: num(hi), low: num(lo), highMs: hiMs, lowMs: loMs,
    highAgeMs: hiMs == null ? null : endMs - hiMs, lowAgeMs: loMs == null ? null : endMs - loMs,
    maxDrawdown: num(maxDrawdown), maxRebound: num(maxRebound),
    currentFromHigh: num(currentFromHigh), currentFromLow: num(currentFromLow),
    R: num(R),
    normDrawdown: norm(maxDrawdown) == null ? null : num(norm(maxDrawdown), 1),
    normRebound: norm(maxRebound) == null ? null : num(norm(maxRebound), 1),
    normFromHigh: norm(currentFromHigh) == null ? null : num(norm(currentFromHigh), 1),
    normFromLow: norm(currentFromLow) == null ? null : num(norm(currentFromLow), 1),
    elapsedHours: num(elapsedHours, 3),
    pace: pace == null ? null : num(pace, 4),
  };
}

/**
 * Change in pace between a recent window and the immediately preceding, equal-length window.
 * A slowdown is NOT a reversal: "up-pace-slowing" only flips to "direction-changed" when the pace
 * sign actually changes.
 */
function paceChange(recentPace, previousPace) {
  if (recentPace == null || previousPace == null) return null;
  const delta = recentPace - previousPace;
  let label;
  if (recentPace >= 0 && previousPace >= 0) {
    label = delta > 0 ? 'up-pace-increasing' : (delta < 0 ? 'up-pace-slowing' : 'up-pace-steady');
  } else if (recentPace <= 0 && previousPace <= 0) {
    label = recentPace < previousPace ? 'down-pace-increasing' : (recentPace > previousPace ? 'down-pace-slowing' : 'down-pace-steady');
  } else {
    label = 'direction-changed';                 // pace crossed zero: recent direction changed
  }
  return { recentPace: num(recentPace, 4), previousPace: num(previousPace, 4), delta: num(delta, 4), label };
}

module.exports = { movementMetrics, paceChange };
