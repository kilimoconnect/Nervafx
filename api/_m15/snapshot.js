'use strict';

/**
 * M15 Intelligence — post-close snapshot planning & state machine (Phase 3, pure).
 *
 * The scheduled job must not assume it fires exactly on time or that every pair's
 * candle is present. This module contains the deterministic, DB-free logic:
 *   • which completed M15 closes still need a snapshot (bounded catch-up),
 *   • the COMPLETE / INCOMPLETE decision for a computed run,
 *   • idempotency (the same close+version+inputs never duplicates).
 * The thin DB writer (endpoint) uses these; keeping them pure makes missed,
 * duplicate, overlapping and incomplete invocations unit-testable without a
 * database. No order logic anywhere.
 */

const { CONFIG } = require('./config');
const { latestCompletedM15Ms, M15_MS, idempotencyKey } = require('./data');

/**
 * Frame-open closes that still need a COMPLETE snapshot, newest first, bounded.
 * @param nowMs        wall clock (job invocation time — may be late/early)
 * @param completeSet  Set of frame-open ms already COMPLETE for the active version
 * @param opts         { cfg, maxCatchup=8 } — at most this many closes per run
 */
function plannedCloses(nowMs, completeSet, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const maxCatchup = opts.maxCatchup || 8;                 // ≤ 2h of M15 catch-up
  const latest = latestCompletedM15Ms(nowMs, cfg);         // no-lookahead frame open
  const out = [];
  for (let i = 0; i < maxCatchup; i++) {
    const frame = latest - i * M15_MS;
    if (!completeSet.has(frame)) out.push(frame);
  }
  return out;                                              // newest-first
}

/** The exact M15 close (UTC) for a frame open. */
function closeOf(frameOpenMs) { return frameOpenMs + M15_MS; }

/**
 * COMPLETE only when all 28 pairs were processed on one aligned frame with no
 * missing pairs; otherwise INCOMPLETE. Never report COMPLETE on a partial run.
 */
function snapshotStatus({ pairsProcessed, pairsExpected = 28, syncState, missingPairs = [] }) {
  const complete = pairsProcessed === pairsExpected && syncState === 'ALIGNED' && (!missingPairs || missingPairs.length === 0);
  return complete ? 'COMPLETE' : 'INCOMPLETE';
}

/** Idempotency key for a snapshot: identical (frame, version, inputs) ⇒ identical. */
function snapshotKey(frameOpenMs, calculationVersion, inputHash) {
  return idempotencyKey(frameOpenMs, calculationVersion, inputHash);
}

/** Freshness of a snapshot/recompute relative to now, in seconds and candles. */
function freshness(closeTimeMs, nowMs, cfg = CONFIG) {
  const ageSec = Math.max(0, Math.round((nowMs - closeTimeMs) / 1000));
  return { ageSeconds: ageSec, ageCandles: +(ageSec / (M15_MS / 1000)).toFixed(2), stale: (nowMs - closeTimeMs) > cfg.processing.maxCandleAgeSeconds * 1000 };
}

module.exports = { plannedCloses, closeOf, snapshotStatus, snapshotKey, freshness };
