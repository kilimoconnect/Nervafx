'use strict';

/**
 * SCS — Section 2: trading calendar & candle normalization (pure, deterministic).
 *
 * All timestamps are UTC ms internally. Trading days align to 17:00 America/
 * New_York; the week aligns on Friday. Only completed candles are used. D1 and
 * H4 are synthesized from completed H1 candles (backtest_candles stores no native
 * D1/H4). Saturday/Sunday never form standalone trading days; genuine Sunday
 * 17:00 NY reopen candles are assigned to Monday's session. Weekend gaps add no
 * candles, so candle-age (counted in array positions) never grows over a weekend.
 * The SAME assembly is used by live evaluation, history and backtesting.
 */

const { CONFIG } = require('./_scs-config');

const H1_MS = CONFIG.h1Ms;
const H4_MS = CONFIG.h4Ms;
const ANCHOR_H = CONFIG.dayAnchorHour;     // 17
const NY = CONFIG.dayAnchorTz;             // America/New_York

// ── timezone helpers ─────────────────────────────────────────────────────────
function partsInTz(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of dtf.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = +p.value;
  if (o.hour === 24) o.hour = 0;
  return o; // {year,month,day,hour,minute,second}
}

/** Convert a wall-clock time in `tz` to UTC ms (single-correction, DST-safe for standard offsets). */
function zonedWallToUtcMs(y, mo, d, h, mi, tz) {
  const a = Date.UTC(y, mo - 1, d, h, mi, 0);
  const p = partsInTz(a, tz);
  const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return a + (a - seen);
}

/** Weekday (0=Sun … 6=Sat) of a NY calendar date. */
function weekdayOfDate(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }
function addCalendarDays(y, mo, d, n) {
  const dt = new Date(Date.UTC(y, mo - 1, d)); dt.setUTCDate(dt.getUTCDate() + n);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

// ── trading-day boundaries (17:00 NY) ────────────────────────────────────────
/** Start (17:00 NY) of the trading session that CONTAINS `ms`. */
function sessionStartUtc(ms) {
  const p = partsInTz(ms, NY);
  let d = { year: p.year, month: p.month, day: p.day };
  if (p.hour < ANCHOR_H) d = addCalendarDays(d.year, d.month, d.day, -1);
  return zonedWallToUtcMs(d.year, d.month, d.day, ANCHOR_H, 0, NY);
}
/** End boundary (next 17:00 NY) of the session that starts at `sessionStartMs`. */
function sessionEndUtc(sessionStartMs) {
  const p = partsInTz(sessionStartMs, NY);
  const n = addCalendarDays(p.year, p.month, p.day, 1);
  return zonedWallToUtcMs(n.year, n.month, n.day, ANCHOR_H, 0, NY);
}
/** A session is a real trading day only if its 17:00-NY start falls on Sun–Thu. */
function isTradingSessionStart(sessionStartMs) {
  const p = partsInTz(sessionStartMs, NY);
  const wd = weekdayOfDate(p.year, p.month, p.day);
  return wd >= 0 && wd <= 4; // Sun(0)…Thu(4) start → Mon…Fri close
}
/** Label a session by the calendar date it CLOSES on (FX convention: Sun-start = Monday). */
function sessionLabel(sessionStartMs) {
  const p = partsInTz(sessionEndUtc(sessionStartMs), NY);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// ── candle normalization ─────────────────────────────────────────────────────
function validOHLC(o, h, l, c) {
  if (![o, h, l, c].every(Number.isFinite)) return false;
  if (h < l) return false;
  return !(h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9);
}

/**
 * Completed-only H1 candles ≤ evalMs, deduped, sorted, weekend-closed rows
 * dropped. Accepts rows with `time`/`openMs` and OHLC.
 */
function normalizeH1(rows, evalMs) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const openMs = r.openMs != null ? r.openMs : new Date(r.time).getTime();
    if (!Number.isFinite(openMs)) continue;
    if (openMs + H1_MS > evalMs) continue;                 // forming candle → excluded
    const o = +r.open, h = +r.high, l = +r.low, c = +r.close;
    if (!validOHLC(o, h, l, c)) continue;
    if (!isTradingSessionStart(sessionStartUtc(openMs))) continue; // weekend-closed
    if (seen.has(openMs)) continue; seen.add(openMs);
    out.push({ openMs, time: new Date(openMs).toISOString(), open: o, high: h, low: l, close: c });
  }
  out.sort((a, b) => a.openMs - b.openMs);
  return out;
}

/** Aggregate completed H1 into buckets keyed by a start function; returns sorted candles. */
function aggregate(h1, evalMs, startOf, endOf) {
  const buckets = new Map();
  for (const c of h1) {
    const start = startOf(c.openMs);
    let b = buckets.get(start);
    if (!b) { b = { openMs: start, endMs: endOf(start), open: c.open, high: c.high, low: c.low, close: c.close, _firstOpen: c.openMs, _lastOpen: c.openMs }; buckets.set(start, b); }
    else {
      if (c.high > b.high) b.high = c.high;
      if (c.low < b.low) b.low = c.low;
      if (c.openMs < b._firstOpen) { b._firstOpen = c.openMs; b.open = c.open; }
      if (c.openMs > b._lastOpen) { b._lastOpen = c.openMs; b.close = c.close; }
    }
  }
  return [...buckets.values()]
    .filter((b) => b.endMs <= evalMs)                       // completed buckets only
    .sort((a, b) => a.openMs - b.openMs)
    .map((b) => ({ openMs: b.openMs, endMs: b.endMs, time: new Date(b.openMs).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close }));
}

/** Completed D1 (trading-day) candles from completed H1. */
function assembleD1(h1, evalMs) {
  return aggregate(h1, evalMs, sessionStartUtc, sessionEndUtc).map((d) => ({ ...d, session: sessionLabel(d.openMs) }));
}

/** H4 bucket start = session start + k·4h (session-relative, so aligned to 17:00 NY). */
function h4StartUtc(ms) {
  const s = sessionStartUtc(ms);
  const k = Math.floor((ms - s) / H4_MS);
  return s + k * H4_MS;
}
/** Completed H4 candles from completed H1 (session-relative 4h buckets). */
function assembleH4(h1, evalMs) {
  return aggregate(h1, evalMs, h4StartUtc, (s) => s + H4_MS);
}

// ── Friday / weekend state ───────────────────────────────────────────────────
/** Most recent (or upcoming, if inside the trading week) Friday 17:00 NY close ≥/around ms. */
function fridayCloseUtc(ms) {
  const p = partsInTz(ms, NY);
  const wd = weekdayOfDate(p.year, p.month, p.day);
  // days until Friday (5); if it's already past Fri 17:00 we roll to next week
  let delta = (5 - wd + 7) % 7;
  let cand = addCalendarDays(p.year, p.month, p.day, delta);
  let close = zonedWallToUtcMs(cand.year, cand.month, cand.day, ANCHOR_H, 0, NY);
  if (close <= ms) { cand = addCalendarDays(cand.year, cand.month, cand.day, 7); close = zonedWallToUtcMs(cand.year, cand.month, cand.day, ANCHOR_H, 0, NY); }
  return close;
}
/** True inside the final `hours` before Friday 17:00 NY close. */
function inFridayCutoff(ms, hours = CONFIG.fridayNoEntryHours) {
  const close = fridayCloseUtc(ms);
  return ms >= close - hours * H1_MS && ms < close;
}
/** True when the market is closed for the weekend (Fri 17:00 NY → Sun 17:00 NY). */
function isWeekendClosed(ms) {
  const start = sessionStartUtc(ms);
  return !isTradingSessionStart(start);
}

// ── evaluation ordering when D1/H4/H1 close together ─────────────────────────
const EVAL_ORDER = Object.freeze(['D1', 'H4', 'H1']);
/** Which timeframes close exactly at H1-close `ms` (D1 first, H4 second, H1 third). */
function closesAt(ms) {
  const out = { D1: false, H4: false, H1: true }; // ms is always an H1 close in the coordinator
  if (ms === sessionEndUtc(sessionStartUtc(ms - 1))) out.D1 = true; // ms is a 17:00 NY boundary
  if ((ms - h4StartUtc(ms - 1)) === H4_MS) out.H4 = true;           // ms is a 4h boundary within a session
  return out;
}

module.exports = {
  H1_MS, H4_MS, NY,
  partsInTz, zonedWallToUtcMs, weekdayOfDate, addCalendarDays,
  sessionStartUtc, sessionEndUtc, isTradingSessionStart, sessionLabel,
  validOHLC, normalizeH1, aggregate, assembleD1, assembleH4, h4StartUtc,
  fridayCloseUtc, inFridayCutoff, isWeekendClosed,
  EVAL_ORDER, closesAt,
};
