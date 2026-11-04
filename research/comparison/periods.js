'use strict';

/**
 * Period definitions for the three views. Trading day = UTC calendar day. Sessions use
 * named, DST-aware timezones (offsets computed per-instant via Intl). Only FULLY
 * completed days/sessions (end ≤ asOf and ≤ latest data) are "completed"; the
 * developing day is explicitly labelled and excludes the forming M15 candle.
 */

const { DAY_MS, M15_MS, sessionByName } = require('./config');

const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

/** Wall-clock parts of a UTC instant in a named timezone. */
function zparts(tz, utcMs) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of f.formatToParts(new Date(utcMs))) if (x.type !== 'literal') p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +(p.hour === '24' ? '00' : p.hour), mi: +p.minute, s: +p.second };
}
/** UTC ms for a given local wall-clock time in a timezone (DST-aware; converges). */
function zonedToUtc(tz, y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let k = 0; k < 3; k++) { const p = zparts(tz, guess); const localAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s); guess += Date.UTC(y, mo - 1, d, h, mi) - localAsUtc; }
  return guess;
}

/** Latest `count` fully-completed UTC trading days with end ≤ min(asOf, lastDataMs). */
function completedDays(asOfMs, lastDataMs, count) {
  const cap = Math.min(asOfMs, lastDataMs == null ? asOfMs : lastDataMs);
  let end = dayStart(cap);                 // a day [end−DAY, end) is complete once `end` ≤ cap
  const out = [];
  while (out.length < count && end > 0) {
    const start = end - DAY_MS;
    out.push({ startMs: start, endMs: end, label: new Date(start).toISOString().slice(0, 10), status: 'completed' });
    end -= DAY_MS;
  }
  return out.reverse();   // oldest → newest
}

/** Today-so-far (developing) + the previous `extra` days through the SAME elapsed cutoff. */
function todaySoFar(asOfMs, lastDataMs, extra) {
  const cutoff = Math.min(asOfMs, lastDataMs == null ? asOfMs : lastDataMs);
  const todayStart = dayStart(cutoff);
  const elapsed = cutoff - todayStart;     // elapsed into the trading day
  const periods = [];
  for (let k = extra; k >= 1; k--) { const ds = todayStart - k * DAY_MS; periods.push({ startMs: ds, endMs: ds + elapsed, label: new Date(ds).toISOString().slice(0, 10) + ' (through +' + Math.round(elapsed / 3600000) + 'h)', status: 'elapsed-day' }); }
  periods.push({ startMs: todayStart, endMs: cutoff, label: 'Today so far', status: 'developing', cutoffMs: cutoff, elapsedMs: elapsed });
  return periods;
}

/** Latest completed occurrences of a session + previous 2 (DST-aware). */
function completedSessions(sessionName, asOfMs, lastDataMs, count) {
  const sess = sessionByName(sessionName);
  const cap = Math.min(asOfMs, lastDataMs == null ? asOfMs : lastDataMs);
  const out = [];
  for (let back = 0; back < 20 && out.length < count; back++) {
    const probe = cap - back * DAY_MS;
    const lp = zparts(sess.tz, probe);                    // local date at the probe
    const startMs = zonedToUtc(sess.tz, lp.y, lp.mo, lp.d, sess.startHour, 0);
    let endMs = zonedToUtc(sess.tz, lp.y, lp.mo, lp.d, sess.endHour, 0);
    if (endMs <= startMs) endMs += DAY_MS;               // (guard) overnight sessions
    if (endMs > cap) continue;                            // not yet completed
    if (out.length && out[out.length - 1].startMs === startMs) continue;   // dedupe
    out.push({ startMs, endMs, label: sess.label + ' · ' + new Date(startMs).toISOString().slice(0, 10), status: 'completed', tz: sess.tz, session: sess.name });
  }
  return out.reverse();
}

module.exports = { dayStart, zparts, zonedToUtc, completedDays, todaySoFar, completedSessions };
