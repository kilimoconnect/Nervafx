'use strict';

/**
 * NervaFX Currency Movement Engine — calculation windows.
 *
 * Each window resolves to the H1-open bounds [startOpenMs, endOpenMs] of the
 * completed candles it covers, plus a status. Because log returns are additive,
 * the scan sums per-hour currency movements across these bounds. Reuses the
 * shared DST-safe zonedWallToUtcMs only.
 */

const { zonedWallToUtcMs } = require('./_h1c-time');
const {
  HOUR_MS, EAT_TZ, LONDON_TZ, SESSION_START_HOUR, SESSION_END_HOUR, LONDON_OPEN_HOUR,
} = require('./_cme-constants');

function partsInTz(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = {};
  for (const p of dtf.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = p.value;
  return o;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function isTradingDay(dateStr) { const w = new Date(dateStr + 'T12:00:00Z').getUTCDay(); return w >= 1 && w <= 5; }
function mostRecentSessionDate(dateStr) { let d = dateStr; for (let i = 0; i < 7 && !isTradingDay(d); i++) d = addDays(d, -1); return d; }

/** The reference-session (17:00–23:00 EAT) date active at evalMs, weekend-aware. */
function referenceSessionDate(evalMs) {
  const e = partsInTz(evalMs, EAT_TZ);
  const h = Number(e.hour);
  const today = e.year + '-' + e.month + '-' + e.day;
  if (h >= SESSION_START_HOUR && h < SESSION_END_HOUR && isTradingDay(today)) return { forming: true, date: today };
  const candidate = h >= SESSION_END_HOUR ? today : addDays(today, -1);
  return { forming: false, date: mostRecentSessionDate(candidate) };
}
function sessionStartUtc(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return zonedWallToUtcMs(y, m, d, SESSION_START_HOUR, 0, EAT_TZ); }
function eatDayStartUtc(evalMs) { const e = partsInTz(evalMs, EAT_TZ); return zonedWallToUtcMs(Number(e.year), Number(e.month), Number(e.day), 0, 0, EAT_TZ); }
function londonOpenForCycle(sessionEndUtc) { const lp = partsInTz(sessionEndUtc + 12 * HOUR_MS, LONDON_TZ); return zonedWallToUtcMs(Number(lp.year), Number(lp.month), Number(lp.day), LONDON_OPEN_HOUR, 0, LONDON_TZ); }

const lastCompletedH1Close = (evalMs) => Math.floor(evalMs / HOUR_MS) * HOUR_MS;

/**
 * @returns {{ok:boolean, status:string, startOpenMs?:number, endOpenMs?:number, meta?:object}}
 *   status: OK | NOT_ACTIVE | INCOMPLETE_WINDOW
 */
function windowBounds(name, evalMs) {
  const lastClose = lastCompletedH1Close(evalMs);
  const lastOpen = lastClose - HOUR_MS;
  if (lastOpen < 0) return { ok: false, status: 'NOT_ACTIVE' };

  if (name === 'H1') return { ok: true, status: 'OK', startOpenMs: lastOpen, endOpenMs: lastOpen };

  const ref = referenceSessionDate(evalMs);
  const sStart = sessionStartUtc(ref.date);
  const sEnd = sStart + 6 * HOUR_MS; // 23:00 EAT
  const london = londonOpenForCycle(sEnd);

  if (name === 'REFERENCE_SESSION') {
    if (sEnd > evalMs) return { ok: false, status: ref.forming ? 'INCOMPLETE_WINDOW' : 'NOT_ACTIVE' };
    return { ok: true, status: 'OK', startOpenMs: sStart, endOpenMs: sStart + 5 * HOUR_MS, meta: { date: ref.date } };
  }
  if (name === 'ASIA_TO_DATE') {
    const end = Math.min(lastClose, london);      // Asia runs 23:00 EAT → London open (or now)
    if (end <= sEnd) return { ok: false, status: 'NOT_ACTIVE' };
    return { ok: true, status: 'OK', startOpenMs: sEnd, endOpenMs: end - HOUR_MS, meta: { londonOpenUtc: new Date(london).toISOString() } };
  }
  if (name === 'LONDON_TO_DATE') {
    if (lastClose <= london) return { ok: false, status: 'NOT_ACTIVE' };
    return { ok: true, status: 'OK', startOpenMs: london, endOpenMs: lastClose - HOUR_MS, meta: { londonOpenUtc: new Date(london).toISOString() } };
  }
  if (name === 'DAY_TO_DATE') {
    const dayStart = eatDayStartUtc(evalMs);
    if (lastClose <= dayStart) return { ok: false, status: 'NOT_ACTIVE' };
    return { ok: true, status: 'OK', startOpenMs: dayStart, endOpenMs: lastClose - HOUR_MS };
  }
  return { ok: false, status: 'NOT_ACTIVE' };
}

module.exports = {
  partsInTz, referenceSessionDate, sessionStartUtc, londonOpenForCycle, eatDayStartUtc,
  lastCompletedH1Close, windowBounds,
};
