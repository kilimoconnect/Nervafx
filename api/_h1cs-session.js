'use strict';

/**
 * NervaFX H1 Continuation Engine — SESSION reference-window + qualification.
 *
 * Pure/deterministic. Reuses the Generic engine's DST-safe zonedWallToUtcMs and
 * the shared math utilities; adds Session-only reference-session maths.
 */

const { zonedWallToUtcMs } = require('./_h1c-time');
const { atr, safeDivide } = require('./_h1c-math');
const {
  HOUR_MS, EAT_TZ, LONDON_TZ, SESSION_START_HOUR, SESSION_END_HOUR, SESSION_CANDLES,
  LONDON_OPEN_HOUR, SESSION_ATR_PERIOD,
  SESSION_MIN_MOVE_ATR, SESSION_MIN_EFFICIENCY, SESSION_MIN_DIRECTIONAL_CANDLES, SESSION_MIN_CLOSE_QUALITY,
  REJECTIONS,
} = require('./_h1cs-constants');

const r3 = (v) => Math.round(v * 1000) / 1000;

function partsInTz(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = {};
  for (const p of dtf.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = p.value;
  return o;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
/** Weekday (0=Sun..6=Sat) of an EAT calendar date. */
function weekdayOf(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }

/** UTC [start,end] of the 17:00–23:00 EAT window for an EAT date. */
function sessionWindowUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    startUtc: zonedWallToUtcMs(y, m, d, SESSION_START_HOUR, 0, EAT_TZ),
    endUtc: zonedWallToUtcMs(y, m, d, SESSION_END_HOUR, 0, EAT_TZ),
  };
}

/**
 * The reference session ACTIVE at evalMs. Between 17:00–23:00 EAT a new session
 * is still forming (no active setup). ≥23:00 → today's session; <17:00 →
 * yesterday's session (its setup runs until 17:00 EAT today).
 */
function activeReferenceSessionDate(evalMs) {
  const e = partsInTz(evalMs, EAT_TZ);
  const h = Number(e.hour);
  const dateStr = e.year + '-' + e.month + '-' + e.day;
  if (h >= SESSION_START_HOUR && h < SESSION_END_HOUR) return { forming: true, date: dateStr };
  if (h >= SESSION_END_HOUR) return { forming: false, date: dateStr };
  return { forming: false, date: addDays(dateStr, -1) };
}

/** 08:00 Europe/London of the morning that falls inside this post-session cycle. */
function londonOpenForCycle(sessionEndUtc) {
  const lp = partsInTz(sessionEndUtc + 12 * HOUR_MS, LONDON_TZ); // next London morning
  return zonedWallToUtcMs(Number(lp.year), Number(lp.month), Number(lp.day), LONDON_OPEN_HOUR, 0, LONDON_TZ);
}

/**
 * Extract the six 17:00–23:00 EAT candles and build the synthetic reference
 * candle. `candles` must be sanitized (closed, ascending, deduped, with .ms).
 */
function buildReferenceSession(candles, startUtc) {
  const byMs = new Map(candles.map((c) => [c.ms, c]));
  const six = [];
  let prevMs = null;
  for (let k = 0; k < SESSION_CANDLES; k++) {
    const want = startUtc + k * HOUR_MS;
    const c = byMs.get(want);
    if (!c) return { ok: false, reason: REJECTIONS.MISSING_CANDLES };
    if (prevMs != null && c.ms - prevMs !== HOUR_MS) return { ok: false, reason: REJECTIONS.DATA_GAP };
    prevMs = c.ms;
    six.push(c);
  }
  const highs = six.map((c) => c.high);
  const lows = six.map((c) => c.low);
  const synthetic = {
    open: six[0].open,
    high: Math.max.apply(null, highs),
    low: Math.min.apply(null, lows),
    close: six[SESSION_CANDLES - 1].close,
  };
  return { ok: true, six, synthetic };
}

/** ATR(20) up to and including the last session candle (open = start + 5h). */
function sessionAtr(candles, startUtc) {
  const lastSessionMs = startUtc + (SESSION_CANDLES - 1) * HOUR_MS;
  const upto = candles.filter((c) => c.ms <= lastSessionMs);
  return atr(upto, SESSION_ATR_PERIOD);
}

/** Qualify the reference move (BUY/SELL) with failed-condition diagnostics. */
function qualifyReference(six, synthetic, atr20) {
  const move = Math.abs(synthetic.close - synthetic.open);
  const moveATR = safeDivide(move, atr20, 0);

  let prev = synthetic.open, path = 0;
  for (const c of six) { path += Math.abs(c.close - prev); prev = c.close; }
  const efficiency = safeDivide(move, path, 0);

  const dir = synthetic.close > synthetic.open ? 1 : synthetic.close < synthetic.open ? -1 : 0;
  const bull = six.filter((c) => c.close > c.open).length;
  const bear = six.filter((c) => c.close < c.open).length;
  const dirCount = dir > 0 ? bull : dir < 0 ? bear : 0;

  const range = synthetic.high - synthetic.low;
  const closeQuality = dir > 0
    ? safeDivide(synthetic.close - synthetic.low, range, 0)
    : safeDivide(synthetic.high - synthetic.close, range, 0);

  const failed = [];
  if (dir === 0) failed.push('NO_DIRECTION');
  if (moveATR < SESSION_MIN_MOVE_ATR) failed.push('MOVE_ATR');
  if (efficiency < SESSION_MIN_EFFICIENCY) failed.push('EFFICIENCY');
  if (dirCount < SESSION_MIN_DIRECTIONAL_CANDLES) failed.push('DIRECTIONAL_CANDLES');
  if (closeQuality < SESSION_MIN_CLOSE_QUALITY) failed.push('CLOSE_QUALITY');

  return {
    qualified: failed.length === 0 && dir !== 0,
    direction: dir,
    sessionMove: r3(move),
    sessionMoveATR: r3(moveATR),
    sessionEfficiency: r3(efficiency),
    directionalCandleCount: dirCount,
    sessionCloseQuality: r3(closeQuality),
    failedConditions: failed,
  };
}

module.exports = {
  partsInTz, addDays, weekdayOf, sessionWindowUtc, activeReferenceSessionDate,
  londonOpenForCycle, buildReferenceSession, sessionAtr, qualifyReference,
};
