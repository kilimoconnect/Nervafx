'use strict';

/**
 * M15 Strategy Research — research-health & prospective-observation gates (Stage 6).
 * Pure, read-only, isolated from the production engine. Because Stage 5 selected NO
 * candidate, there is NOTHING to place, trigger, or notify as an opportunity — these
 * helpers exist so the research view can show data health honestly and so any FUTURE
 * shadow cohort (started only under a new version if a candidate ever qualifies) can
 * never mistake historical replay for live evidence, or surface stale/incomplete data
 * as a current opportunity. No order path anywhere.
 */

const M15 = 15 * 60 * 1000;

function eat(ms) { return new Date(ms).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') + ' EAT'; }

/** Research-health snapshot from a Stage-1 syncAsOf view + wall clock. */
function researchHealth(view, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  if (view.frameOpenMs == null) return { ok: false, reason: 'NO_DATA', missing: view.missing || [] };
  const closeMs = view.frameOpenMs + M15;
  const missing = view.missing || [], laggards = view.laggards || [];
  const complete = view.aligned === true && missing.length === 0;
  const ageSec = Math.max(0, Math.round((nowMs - closeMs) / 1000));
  const stale = (nowMs - closeMs) > (opts.maxAgeSec || (15 * 60 + 180)) * 1000;
  return {
    ok: true,
    latestCloseUtc: new Date(closeMs).toISOString(), latestCloseEat: eat(closeMs),
    frameOpenUtc: new Date(view.frameOpenMs).toISOString(),
    pairsExpected: 28, pairsPresent: 28 - missing.length, missing, laggards,
    complete, dataAgeSeconds: ageSec, stale,
  };
}

/**
 * Operating checks for the scheduled research observation (staged; scheduler NOT
 * activated in this task). Flags conditions the review must never treat as a clean,
 * current opportunity.
 */
function operatingChecks(o) {
  const closeMs = o.frameOpenMs + M15;
  return {
    lateCandle: (o.nowMs - closeMs) > (o.lateThresholdSec || 300) * 1000,      // candle arrived late
    incompleteSnapshot: (o.pairsPresent != null ? o.pairsPresent : 28) < 28,   // <28 pairs
    gap: o.prevFrameOpenMs != null && (o.frameOpenMs - o.prevFrameOpenMs) > M15 && !o.weekend,
    staleSignal: (o.nowMs - closeMs) > (o.staleSec || (15 * 60 + 180)) * 1000,
    versionChanged: o.prevVersion != null && o.version !== o.prevVersion,       // ⇒ restart cohort
    duplicateRun: !!(o.seenFrames && o.seenFrames.has && o.seenFrames.has(o.frameOpenMs)),
  };
}

/**
 * Research prospective-notice gate. A notice is permitted ONLY for a LIVE, COMPLETE,
 * non-stale observation of a NEW episode. Replay and backfill NEVER notify. (With no
 * selected candidate, this returns nothing in practice — but the gate is enforced and
 * tested so a future cohort cannot leak.)
 */
function shouldNotify(ctx) {
  if (ctx.mode !== 'LIVE') return { notify: false, reason: ctx.mode === 'REPLAY' ? 'REPLAY' : ctx.mode === 'BACKFILL' ? 'BACKFILL' : 'NOT_LIVE' };
  if (ctx.hasSelectedCandidate !== true) return { notify: false, reason: 'NO_SELECTED_CANDIDATE' };
  if (ctx.complete !== true) return { notify: false, reason: 'INCOMPLETE' };
  if (ctx.stale === true) return { notify: false, reason: 'STALE' };
  if (ctx.seenEpisodeIds && ctx.seenEpisodeIds.has && ctx.seenEpisodeIds.has(ctx.episodeId)) return { notify: false, reason: 'DUPLICATE' };
  return { notify: true, reason: 'LIVE_NEW' };
}

/** Observation-log record (for the staged research_shadow_runs table). No economics. */
function observationRecord(o) {
  return {
    version: o.version, source_close_utc: new Date(o.frameOpenMs + M15).toISOString(),
    candle_available_at: o.candleAvailableIso || null, analysis_completed_at: o.analysisCompletedIso || null,
    displayed_notice_at: o.noticeAt || null, episode_id: o.episodeId || null,
    data_missing: !!(o.missing && o.missing.length), data_stale: !!o.stale,
    earliest_manual_decision_at: o.candleAvailableIso || null,   // earliest practicable manual response
    mode: o.mode || 'LIVE',
  };
}

module.exports = { M15, eat, researchHealth, operatingChecks, shouldNotify, observationRecord };
