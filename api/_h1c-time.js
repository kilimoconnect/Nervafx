'use strict';

/**
 * NervaFX H1 Continuation Engine — timezone & H1-boundary helpers (history only).
 *
 * Pure and deterministic; no detector logic. Everything internal is UTC epoch-ms.
 * The frontend mirrors zonedWallToUtcMs/snapToH1 to build the ?at= URL; this
 * module is the unit-tested source of truth and is reused by the API routes for
 * metadata formatting and day-boundary maths.
 */

const { HOUR_MS } = require('./_h1c-constants');

/**
 * Interpret wall-clock components as a time in `tz` → UTC epoch-ms. DST-safe:
 * the offset is resolved at that exact instant, not a fixed guess.
 */
function zonedWallToUtcMs(year, month, day, hour, minute, tz) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(asIfUtc))) if (part.type !== 'literal') p[part.type] = part.value;
  const hh = Number(p.hour) % 24;
  const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hh, Number(p.minute), Number(p.second));
  return asIfUtc + (asIfUtc - seen);
}

/** Snap DOWN to the H1 boundary (the latest completed H1 close at/at-or-before ms). */
function snapToH1(ms) { return Math.floor(ms / HOUR_MS) * HOUR_MS; }

/** A request is historical iff it carries ?at. */
function isHistoricalRequest(query) { return !!(query && query.at); }

function prevH1(ms) { return snapToH1(ms) - HOUR_MS; }
function nextH1(ms) { return snapToH1(ms) + HOUR_MS; }

/** Next H1 is allowed only if it does not move past the latest completed candle. */
function nextH1Allowed(atMs, latestCloseMs) {
  if (latestCloseMs == null) return true;
  return snapToH1(atMs) + HOUR_MS <= latestCloseMs;
}

/** Format an instant in a timezone as "14 Aug 2026, 10:00" (presentation only). */
function localStr(ms, tz) {
  if (ms == null) return null;
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: tz || 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** UTC [start, end) epoch-ms of a local calendar day, DST-correct at both edges. */
function localDayBoundsUtc(dateStr, tz) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const startMs = zonedWallToUtcMs(y, mo, d, 0, 0, tz);
  const nd = new Date(Date.UTC(y, mo - 1, d));
  nd.setUTCDate(nd.getUTCDate() + 1);
  const endMs = zonedWallToUtcMs(nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), 0, 0, tz);
  return { startMs, endMs };
}

module.exports = {
  zonedWallToUtcMs, snapToH1, isHistoricalRequest, prevH1, nextH1, nextH1Allowed, localStr, localDayBoundsUtc,
};
