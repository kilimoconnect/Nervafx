'use strict';

/**
 * Historical replay — a deterministic as-of RECOMPUTE (never a filter of today's dashboard).
 * Reuses the exact engine (buildContext/snapshotAt/strengthAt/buildSignalRecord), so replay
 * reproduces the live decisions for the same candle events and settings (parity). Replay is
 * read-only: it writes nothing to the live tables.
 *
 * replayAt(ctx, T, windowFromMs) returns the three clearly-separated blocks the UI shows:
 *   1. snapshot.*          — qualification/strength at the selected time T
 *   2. snapshot.triggerEvals — trigger evaluation at the latest completed trigger candle ≤ T
 *   3. signalsInWindow     — signals generated earlier in [windowFromMs, T], each evaluated
 *                            with the classifications AT ITS OWN trigger close (never later)
 */

const { PAIRS } = require('./config');
const { snapshotAt, strengthAt, buildSignalRecord, prefixEnd } = require('./evaluate');
const { triggerBreakUpto, decideSignal } = require('./trigger');
const { qualifyPairs } = require('./qualify');

/** All distinct completed trigger-candle close timestamps in (fromMs, toMs], ascending. */
function triggerCloseTimes(ctx, fromMs, toMs) {
  const set = new Set();
  for (const pair of PAIRS) {
    for (const c of ctx.trigByPair[pair]) {
      if (c.closeMs > fromMs && c.closeMs <= toMs) set.add(c.closeMs);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** The latest completed trigger-candle close ≤ atMs across all pairs (or null). */
function latestTriggerClose(ctx, atMs) {
  let best = null;
  for (const pair of PAIRS) {
    const arr = ctx.trigByPair[pair];
    const end = prefixEnd(arr, atMs);
    if (end >= 1) { const t = arr[end - 1].closeMs; if (best == null || t > best) best = t; }
  }
  return best;
}

/** Step to the next (dir>0) or previous (dir<0) distinct trigger-candle close from fromMs. */
function stepTriggerClose(ctx, fromMs, dir, boundMs) {
  let best = null;
  for (const pair of PAIRS) {
    for (const c of ctx.trigByPair[pair]) {
      const t = c.closeMs;
      if (dir > 0) { if (t > fromMs && (boundMs == null || t <= boundMs) && (best == null || t < best)) best = t; }
      else { if (t < fromMs && (best == null || t > best)) best = t; }
    }
  }
  return best;
}

/**
 * Sweep the window and reconstruct the signals that fired at each trigger-candle close.
 * Each trigger candle is evaluated with the currency classifications at its OWN close.
 */
function sweepSignals(ctx, fromMs, toMs) {
  const out = [];
  for (const pair of PAIRS) {
    const i0 = pair.indexOf('_');
    const base = pair.slice(0, i0), quote = pair.slice(i0 + 1);
    const arr = ctx.trigByPair[pair];
    for (let i = 1; i < arr.length; i++) {
      const c = arr[i];
      if (c.closeMs <= fromMs || c.closeMs > toMs) continue;
      const tb = triggerBreakUpto(arr, i + 1);           // break of candle i vs i-1
      if (tb.break === 0) continue;
      const strengthAtC = strengthAt(ctx, c.closeMs);
      const cand = qualifyPairs(strengthAtC).all.find((p) => p.pair === pair);
      if (!cand || !cand.direction) continue;
      const decision = decideSignal(cand.direction, tb, strengthAtC, base, quote);
      if (decision.signal) out.push(buildSignalRecord(ctx.def, cand, tb, strengthAtC, null, c.closeMs));
    }
  }
  return out.sort((a, b) => a.triggerCloseMs - b.triggerCloseMs || a.pair.localeCompare(b.pair));
}

/**
 * Full replay payload at T, with the signal history over [windowFromMs, T].
 * The snapshot carries blocks (1) and (2); signalsInWindow is block (3).
 */
function replayAt(ctx, atMs, windowFromMs) {
  const snapshot = snapshotAt(ctx, atMs);
  const latestClose = latestTriggerClose(ctx, atMs);
  const from = windowFromMs == null ? -Infinity : windowFromMs;
  const signalsInWindow = sweepSignals(ctx, from, atMs);
  return {
    strategyKey: ctx.def.key, version: ctx.def.version,
    atMs, windowFromMs: windowFromMs == null ? null : windowFromMs,
    latestTriggerCloseMs: latestClose,
    atBetweenCloses: latestClose != null && latestClose < atMs,
    snapshot, signalsInWindow,
  };
}

module.exports = { triggerCloseTimes, latestTriggerClose, stepTriggerClose, sweepSignals, replayAt };
