'use strict';

/**
 * Evolution-based CURRENCY CONDITION (methodology v2, spec §5–§7).
 *
 * Replaces the v1 "persistent break-of-structure votes" with a reading of CURRENT movement
 * taken from the app's zero-sum 1/8 log-return index (research/comparison/index-build.js).
 * A currency's condition is judged ONLY from its RECENT direction over two rolling windows
 * (fast + slow, per strategy), never from an old break that may no longer hold. Period
 * position (index vs the EAT day/week/month baseline) is reported as DIAGNOSTIC context and
 * does NOT gate the Strong/Weak call.
 *
 * Pure (no I/O). Reuses, unchanged:
 *   - idxAtOrBefore  (research/comparison/index-build)  — causal index lookup
 *   - movementMetrics(xs,times,tol) (research/comparison/movement) — net M, direction label,
 *       and `balance` (= 100·signed-efficiency, the spec's §5D signed efficiency), pace
 *   - breadth(ccy,byPair,startMs,endMs,cfg) (research/comparison/candles) — §5C recent breadth
 *
 * Windows are measured on the CONTINUOUS index, so a window may span a period baseline — that
 * is intended; only the period-position diagnostic resets at the baseline. No look-ahead: every
 * lookup is a causal prefix (position ≤ the M15 close ≤ cutoff).
 *
 * Research only — relative movement, NOT a probability or profitability claim.
 */

const { idxAtOrBefore } = require('../comparison/index-build');
const { breadth } = require('../comparison/candles');
const { movementMetrics, paceChange } = require('../comparison/movement');
const { CURRENCIES, CONFIG } = require('../comparison/config');

const BASE_TOL = 0.005;                 // pp — movementMetrics' intrinsic direction tolerance
const r4 = (x) => (x == null || !isFinite(x) ? null : +(+x).toFixed(4));

/** True iff every step in [startPos,endPos] is exactly one base interval apart (no bridged gap). */
function contiguous(built, startPos, endPos) {
  const tl = built.timeline;
  for (let i = startPos + 1; i <= endPos; i++) if (tl[i] - tl[i - 1] !== built.baseMs) return false;
  return true;
}

/** Per-currency level series (pp), rebased to the window open at startPos. */
function series(built, ccy, startPos, endPos) {
  const base = built.index[ccy][startPos];
  const xs = [], times = [];
  for (let i = startPos; i <= endPos; i++) { xs.push(100 * (built.index[ccy][i] / base - 1)); times.push(built.timeline[i]); }
  return { xs, times };
}

/** Movement + breadth over a rolling window of `intervals` M15 steps ending at endPos. */
function windowMetrics(built, byPair, ccy, endPos, intervals, cfg, tol) {
  const startPos = endPos - intervals;
  if (startPos < 0) return { available: false, reason: 'insufficient-history', intervals: 0 };
  const contig = contiguous(built, startPos, endPos);
  const { xs, times } = series(built, ccy, startPos, endPos);
  const m = movementMetrics(xs, times, tol);
  const startMs = built.timeline[startPos], endMs = built.timeline[endPos];
  const br = (byPair && cfg) ? breadth(ccy, byPair, startMs, endMs, cfg) : null;
  return {
    available: contig && m.ok, reason: contig ? (m.ok ? null : 'insufficient-observations') : 'market-gap',
    intervals, startMs, endMs,
    M: r4(m.M), direction: m.ok ? m.direction : null,
    signedEff: m.ok && m.balance != null ? r4(m.balance / 100) : null,   // §5D signed efficiency ∈ [−1,1]
    efficiency: m.ok ? m.efficiency : null,
    pace: m.ok ? m.pace : null,
    breadth: br,
  };
}

/** Period position (DIAGNOSTIC): index now vs the period baseline, with peak/trough over the period. */
function periodPosition(built, ccy, cutoffMs, periodStart) {
  const startMs = periodStart(cutoffMs);
  const o = idxAtOrBefore(built, ccy, startMs);
  const e = idxAtOrBefore(built, ccy, cutoffMs);
  if (!o || !e) return { periodStartMs: startMs, periodPct: null, periodPeak: null, periodTrough: null };
  let peak = -Infinity, trough = Infinity;
  for (let i = o.idx; i <= e.idx; i++) { const v = 100 * (built.index[ccy][i] / o.value - 1); if (v > peak) peak = v; if (v < trough) trough = v; }
  return { periodStartMs: startMs, periodPct: r4(100 * (e.value / o.value - 1)), periodPeak: r4(peak), periodTrough: r4(trough) };
}

/**
 * Classification (§6) — RECENT-DIRECTION-ONLY (period position never gates):
 *   strong : fast & slow both strengthening, fast signed-efficiency ≥ effDeadband,
 *            fast-window appreciated breadth ≥ breadthMin.
 *   weak   : the mirror (both weakening, signed-efficiency ≤ −effDeadband, depreciated ≥ breadthMin).
 *   mixed  : windows disagree, or breadth/efficiency below the gate.
 *   insufficient : a window lacks contiguous coverage / observations.
 */
function classify(fast, slow, params) {
  if (!fast.available || !slow.available) return 'insufficient';
  const bm = params.breadthMin, ed = params.effDeadband;
  const fUp = fast.direction === 'strengthening', fDown = fast.direction === 'weakening';
  const sUp = slow.direction === 'strengthening', sDown = slow.direction === 'weakening';
  const appr = fast.breadth ? fast.breadth.appreciated : 0;
  const depr = fast.breadth ? fast.breadth.depreciated : 0;
  const effStrong = fast.signedEff != null && fast.signedEff >= ed;
  const effWeak = fast.signedEff != null && fast.signedEff <= -ed;
  if (fUp && sUp && effStrong && appr >= bm) return 'strong';
  if (fDown && sDown && effWeak && depr >= bm) return 'weak';
  return 'mixed';
}

/** Full condition for one currency at cutoffMs. */
function currencyCondition(built, byPair, ccy, cutoffMs, cond, params, cfg = CONFIG) {
  const at = idxAtOrBefore(built, ccy, cutoffMs);
  const period = periodPosition(built, ccy, cutoffMs, cond.periodStart);
  if (!at) {
    return { currency: ccy, classification: 'insufficient', complete: false, score: null,
      ...period, fast: { available: false }, slow: { available: false }, paceChange: null };
  }
  const endPos = at.idx;
  const tol = Math.max(BASE_TOL, params.dirDeadband || 0);
  const fast = windowMetrics(built, byPair, ccy, endPos, cond.fast, cfg, tol);
  const slow = windowMetrics(built, byPair, ccy, endPos, cond.slow, cfg, tol);
  const classification = classify(fast, slow, params);

  // pace change: fast window vs the immediately preceding equal-length window.
  let pc = null;
  if (fast.available) {
    const pe = endPos - cond.fast, ps = pe - cond.fast;
    if (ps >= 0 && contiguous(built, ps, pe)) {
      const prev = series(built, ccy, ps, pe);
      const pm = movementMetrics(prev.xs, prev.times, tol);
      if (pm.ok) pc = paceChange(fast.pace, pm.pace);
    }
  }

  const score = (fast.available && fast.signedEff != null) ? Math.round(fast.signedEff * 100) : null;
  return {
    currency: ccy, classification, complete: fast.available && slow.available, score,
    periodStartMs: period.periodStartMs, periodPct: period.periodPct, periodPeak: period.periodPeak, periodTrough: period.periodTrough,
    fast, slow, paceChange: pc,
  };
}

/** Condition map for all 8 currencies at cutoffMs (the drop-in replacement for v1 `strength`). */
function conditionAll(built, byPair, cutoffMs, cond, params, cfg = CONFIG) {
  const out = {};
  for (const c of CURRENCIES) out[c] = currencyCondition(built, byPair, c, cutoffMs, cond, params, cfg);
  return out;
}

/** D(t) = pctBase − pctQuote over a rolling window (continuous index, rebased to the window open). */
function dWindow(built, base, quote, endPos, intervals, tol) {
  const startPos = endPos - intervals;
  if (startPos < 0) return { available: false };
  const contig = contiguous(built, startPos, endPos);
  const baseA = built.index[base][startPos], baseB = built.index[quote][startPos];
  const xs = [], times = [];
  for (let i = startPos; i <= endPos; i++) {
    xs.push(100 * (built.index[base][i] / baseA - 1) - 100 * (built.index[quote][i] / baseB - 1));
    times.push(built.timeline[i]);
  }
  const m = movementMetrics(xs, times, tol);
  return { available: contig && m.ok, M: m.ok ? m.M : null, direction: m.ok ? m.direction : null };
}

/**
 * §7 — the directional currency spread D(t)=base−quote must be WIDENING in the signed direction
 * over BOTH windows (BUY → D rising; SELL → D falling), beyond the movement deadband.
 */
function spreadExpands(built, base, quote, cutoffMs, cond, direction, params) {
  const at = idxAtOrBefore(built, base, cutoffMs);
  if (!at) return { expanding: false, reason: 'no-data' };
  const endPos = at.idx;
  const tol = Math.max(BASE_TOL, params.dirDeadband || 0);
  const db = params.dirDeadband || 0;
  const f = dWindow(built, base, quote, endPos, cond.fast, tol);
  const s = dWindow(built, base, quote, endPos, cond.slow, tol);
  if (!f.available || !s.available) return { expanding: false, reason: 'insufficient', fast: f, slow: s };
  const expanding = direction === 'BUY' ? (f.M > db && s.M > db) : (f.M < -db && s.M < -db);
  return {
    expanding, direction,
    fast: { M: r4(f.M), direction: f.direction }, slow: { M: r4(s.M), direction: s.direction },
  };
}

module.exports = { currencyCondition, conditionAll, spreadExpands, classify, windowMetrics, periodPosition, contiguous, BASE_TOL };
