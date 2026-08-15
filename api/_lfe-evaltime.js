'use strict';

/**
 * NervaFX Liquidity Failure Engine — evaluation-time resolution.
 *
 * Everything internal is UTC epoch-ms. Display timezone is a presentation
 * concern only. Guarantees for point-in-time historical replay:
 *   - selections snap DOWN to the last completed M15 boundary,
 *   - only candles whose CLOSE ≤ evaluation time may ever be used,
 *   - no future candles, no repainting, "Latest Available" is a real timestamp.
 */

const { HOUR_MS, M15_MS, CONFIG, EVAL_MODE } = require('./_lfe-constants');

/**
 * Interpret wall-clock components as a time in `tz` and return UTC epoch-ms.
 * DST-safe: the offset is resolved at that specific instant, not a fixed guess.
 */
function zonedWallToUtcMs(year, month, day, hour, minute, tz) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(asIfUtc))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // Intl renders 24:00 as hour "24" at midnight for some zones — normalise.
  const hh = (Number(parts.hour) % 24);
  const seenAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hh, Number(parts.minute), Number(parts.second),
  );
  const offset = asIfUtc - seenAsUtc;
  return asIfUtc + offset;
}

/** Snap DOWN to the latest completed 15-minute boundary. */
function snapToM15Ms(utcMs) {
  return Math.floor(utcMs / M15_MS) * M15_MS;
}

/**
 * Close time of the latest H1 candle that has completed by `evalMs`
 * (i.e. the last H1 boundary ≤ evalMs). At evalMs=10:30 → 10:00, meaning the
 * 09:00–10:00 candle (open 09:00) is the newest usable H1.
 */
function lastCompletedH1CloseMs(evalMs) {
  return Math.floor(evalMs / HOUR_MS) * HOUR_MS;
}

/** Inclusive upper bound on H1 OPEN time for a candle to be complete by evalMs. */
function h1UntilMs(evalMs) { return evalMs - HOUR_MS; }

/** Inclusive upper bound on M15 OPEN time for a candle to be complete by evalMs. */
function m15UntilMs(evalMs) { return evalMs - M15_MS; }

/**
 * Resolve a requested time to a snapped UTC evaluation time, rejecting anything
 * outside the derived coverage window.
 *
 * @param {object} input  one of: {atMs}, {iso}, or {wall:{year,month,day,hour,minute}, timezone}
 * @param {object} [coverage]  { earliestSelectable, latestAvailable } (epoch-ms)
 * @returns {{ok:boolean, evaluationTimeUtc?:number, requestedMs?:number, snappedMs?:number, reason?:string}}
 */
function resolveEvaluationTime(input, coverage) {
  let utcMs;
  if (input == null) return { ok: false, reason: 'NO_INPUT' };
  if (input.atMs != null) utcMs = Number(input.atMs);
  else if (input.iso != null) utcMs = new Date(input.iso).getTime();
  else if (input.wall != null) {
    const w = input.wall;
    utcMs = zonedWallToUtcMs(w.year, w.month, w.day, w.hour, w.minute, input.timezone || 'UTC');
  } else return { ok: false, reason: 'NO_INPUT' };

  if (!Number.isFinite(utcMs)) return { ok: false, reason: 'INVALID_TIME' };

  const snapped = snapToM15Ms(utcMs);
  if (coverage) {
    if (Number.isFinite(coverage.earliestSelectable) && snapped < coverage.earliestSelectable) {
      return { ok: false, reason: 'BEFORE_COVERAGE', requestedMs: utcMs, snappedMs: snapped };
    }
    if (Number.isFinite(coverage.latestAvailable) && snapped > coverage.latestAvailable) {
      return { ok: false, reason: 'AFTER_COVERAGE', requestedMs: utcMs, snappedMs: snapped };
    }
  }
  return { ok: true, evaluationTimeUtc: snapped, requestedMs: utcMs, snappedMs: snapped };
}

/**
 * Build the immutable evaluation context handed to the rest of the engine.
 * With no time given it defaults to the latest available candle timestamp.
 */
function buildEvaluationContext(coverage, opts) {
  opts = opts || {};
  const tz = opts.displayTimezone || opts.timezone || 'UTC';
  const hasRequest = opts.atMs != null || opts.iso != null || opts.wall != null;

  let evalMs, resolved;
  if (!hasRequest) {
    evalMs = coverage.latestAvailable;
    resolved = { ok: true, evaluationTimeUtc: evalMs, requestedMs: null };
  } else {
    resolved = resolveEvaluationTime(opts, coverage);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, resolved };
    evalMs = resolved.evaluationTimeUtc;
  }

  const mode = evalMs >= coverage.latestAvailable ? EVAL_MODE.LATEST_AVAILABLE : EVAL_MODE.HISTORICAL;
  return {
    ok: true,
    requestedTime: resolved.requestedMs != null ? new Date(resolved.requestedMs).toISOString() : null,
    evaluationMs: evalMs,
    evaluationTimeUtc: new Date(evalMs).toISOString(),
    mode,
    displayTimezone: tz,
    commonEarliest: coverage.earliestSelectableIso || new Date(coverage.earliestSelectable).toISOString(),
    commonLatest: coverage.commonLatestIso || new Date(coverage.latestAvailable).toISOString(),
    configurationVersion: CONFIG.version,
    lastCompletedH1: new Date(lastCompletedH1CloseMs(evalMs)).toISOString(),
    h1UntilIso: new Date(h1UntilMs(evalMs)).toISOString(),
    m15UntilIso: new Date(m15UntilMs(evalMs)).toISOString(),
  };
}

module.exports = {
  zonedWallToUtcMs,
  snapToM15Ms,
  lastCompletedH1CloseMs,
  h1UntilMs,
  m15UntilMs,
  resolveEvaluationTime,
  buildEvaluationContext,
};
