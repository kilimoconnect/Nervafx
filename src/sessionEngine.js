'use strict';

/**
 * Phase 10 — Trading Session Engine
 *
 * Determines current UTC trading session, quality, and applies
 * session-based confidence adjustments per instrument.
 */

// ─── Session definitions ──────────────────────────────────────────────────────
// Non-overlapping UTC hour buckets covering all 24 hours.
const SESSIONS = [
  { name: 'DEAD_HOURS',  label: 'Dead Hours',        startHour: 21, endHour: 24, quality: 'BLOCKED',   tradesAllowed: false, baseActivity: 5  },
  { name: 'ASIA',        label: 'Asia',               startHour:  0, endHour:  6, quality: 'MEDIUM',    tradesAllowed: true,  baseActivity: 48 },
  { name: 'PRE_LONDON',  label: 'Pre-London',         startHour:  6, endHour:  7, quality: 'LOW',       tradesAllowed: true,  baseActivity: 22 },
  { name: 'LONDON_OPEN', label: 'London Open',        startHour:  7, endHour: 10, quality: 'HIGH',      tradesAllowed: true,  baseActivity: 80 },
  { name: 'LONDON',      label: 'London',             startHour: 10, endHour: 13, quality: 'HIGH',      tradesAllowed: true,  baseActivity: 70 },
  { name: 'LONDON_NY',   label: 'London/NY Overlap',  startHour: 13, endHour: 17, quality: 'VERY_HIGH', tradesAllowed: true,  baseActivity: 92 },
  { name: 'LATE_NY',     label: 'Late NY',            startHour: 17, endHour: 21, quality: 'LOW',       tradesAllowed: true,  baseActivity: 28 },
];

// ─── Quality descriptions ─────────────────────────────────────────────────────
const QUALITY_DESC = {
  VERY_HIGH: 'Continuation & breakouts highly favoured',
  HIGH:      'Good conditions for continuation trades',
  MEDIUM:    'Moderate participation — JPY/AUD/NZD pairs preferred',
  LOW:       'Thin liquidity — reduce size, avoid new entries',
  BLOCKED:   'Trading not permitted this session',
};

// ─── Confidence adjustments by session quality ────────────────────────────────
const QUALITY_CONF_DELTA = {
  VERY_HIGH: +10,
  HIGH:      +5,
  MEDIUM:    0,
  LOW:       -10,
  BLOCKED:   -999,
};

// ─── Pair-specific session bonuses/penalties ──────────────────────────────────
// Applied ON TOP of the quality delta.
// Positive = pair trades well this session. Negative = avoid.
const PAIR_SESSION_DELTA = {
  // ── GBP pairs → London is home ──────────────────────────────────────────
  GBP_USD: { LONDON_OPEN: +8, LONDON: +5, LONDON_NY: +8, LATE_NY: -5, ASIA: -5, PRE_LONDON: -3 },
  GBP_JPY: { LONDON_OPEN: +8, LONDON: +5, LONDON_NY: +8, ASIA: +3,   LATE_NY: -5 },
  GBP_CHF: { LONDON_OPEN: +8, LONDON: +5, LONDON_NY: +5, ASIA: -3 },
  GBP_CAD: { LONDON_OPEN: +8, LONDON: +5, LONDON_NY: +8, ASIA: -3 },
  GBP_AUD: { LONDON_OPEN: +8, LONDON: +5, ASIA: -5 },
  GBP_NZD: { LONDON_OPEN: +8, LONDON: +5, ASIA: -5 },
  // ── EUR pairs → London + overlap ────────────────────────────────────────
  EUR_USD: { LONDON: +5, LONDON_NY: +10, LONDON_OPEN: +5, ASIA: -3 },
  EUR_JPY: { LONDON: +5, LONDON_NY: +8,  LONDON_OPEN: +5 },
  EUR_GBP: { LONDON: +8, LONDON_OPEN: +8, LONDON_NY: +5, ASIA: -5 },
  EUR_CHF: { LONDON: +5, LONDON_OPEN: +5 },
  EUR_CAD: { LONDON_NY: +8, LONDON: +5 },
  EUR_AUD: { LONDON: +5, LONDON_NY: +5 },
  EUR_NZD: { LONDON: +5, LONDON_NY: +5 },
  // ── USD pairs → NY focus ─────────────────────────────────────────────────
  USD_JPY: { LONDON_NY: +8, LONDON: +3, ASIA: +5 },
  USD_CHF: { LONDON_NY: +8, LONDON: +3 },
  USD_CAD: { LONDON_NY: +10, LATE_NY: +3 },
  AUD_USD: { ASIA: +8, LONDON_NY: +5 },
  NZD_USD: { ASIA: +8, LONDON_NY: +5 },
  // ── AUD/NZD → Asia specialist ────────────────────────────────────────────
  AUD_NZD: { ASIA: +10, LONDON: -3, LONDON_NY: -3 },
  AUD_JPY: { ASIA: +8,  LONDON: +5, LONDON_NY: +5 },
  NZD_JPY: { ASIA: +8,  LONDON: +5, LONDON_NY: +5 },
  // ── CAD pairs → NY focus ─────────────────────────────────────────────────
  CAD_CHF: { LONDON_NY: +8, LONDON: +3 },
  CAD_JPY: { LONDON_NY: +8, LONDON: +3, ASIA: +3 },
  // ── CHF cross ────────────────────────────────────────────────────────────
  CHF_JPY: { LONDON: +5, LONDON_OPEN: +5, ASIA: +3 },
};

// ─── Build session result object ──────────────────────────────────────────────
function buildSession(sessName, now, opts = {}) {
  const def          = SESSIONS.find(s => s.name === sessName) || SESSIONS[0];
  const quality      = opts.qualityOverride  || def.quality;
  const baseActivity = opts.activityOverride ?? def.baseActivity;
  const tradesAllowed = opts.blocked != null ? !opts.blocked : def.tradesAllowed;

  // Activity ramp within session window (sin arc — peaks at 50% through)
  const hour     = now.getUTCHours();
  const duration = def.endHour - def.startHour;
  const progress = duration > 0
    ? Math.max(0, Math.min(1, (hour - def.startHour) / duration))
    : 0;
  const ramp         = Math.sin(progress * Math.PI);
  const activityIndex = tradesAllowed
    ? Math.round(Math.max(5, baseActivity * 0.75 + baseActivity * 0.25 * ramp))
    : 0;

  const confDelta = tradesAllowed ? (QUALITY_CONF_DELTA[quality] ?? 0) : -999;

  return {
    session:        sessName,
    label:          def.label,
    quality,
    quality_desc:   QUALITY_DESC[quality] || '',
    trades_allowed: tradesAllowed,
    block_reason:   opts.blockReason || null,
    activity_index: activityIndex,
    conf_delta:     confDelta,
    start_hour:     def.startHour,
    end_hour:       def.endHour,
    utc_hour:       now.getUTCHours(),
    utc_day:        now.getUTCDay(),
    time:           now.toISOString(),
  };
}

// ─── Get current session ──────────────────────────────────────────────────────
function getCurrentSession(now = new Date()) {
  const day  = now.getUTCDay();   // 0=Sun … 6=Sat
  const hour = now.getUTCHours();

  // Saturday: market fully closed
  if (day === 6) {
    return buildSession('DEAD_HOURS', now, {
      blocked: true,
      blockReason: 'Weekend — market closed',
    });
  }

  // Sunday before 22:00 UTC: market not yet open
  if (day === 0 && hour < 22) {
    return buildSession('DEAD_HOURS', now, {
      blocked: true,
      blockReason: 'Sunday — market not yet open',
    });
  }

  // Sunday 22:00+: Sydney thin open
  if (day === 0 && hour >= 22) {
    return buildSession('ASIA', now, {
      qualityOverride: 'LOW',
      activityOverride: 18,
    });
  }

  // Rollover hard block: 21:00–22:00 UTC every trading day
  if (hour === 21) {
    return buildSession('DEAD_HOURS', now, {
      blocked: true,
      blockReason: 'Rollover 21:00–22:00 UTC — no trades',
    });
  }

  // 22:00–23:59: dead hours (post-rollover, pre-Asia)
  if (hour >= 22) {
    return buildSession('DEAD_HOURS', now, {
      blocked: true,
      blockReason: 'Dead hours — low liquidity',
    });
  }

  // Normal session lookup (hours 0–20)
  const sess = SESSIONS.find(s => hour >= s.startHour && hour < s.endHour);
  if (!sess) return buildSession('DEAD_HOURS', now, { blocked: true, blockReason: 'Unknown session' });
  return buildSession(sess.name, now);
}

// ─── Apply session filter to a pair ──────────────────────────────────────────
/**
 * Returns { adjusted_confidence, session_delta, trade_blocked, block_reason }
 * The caller decides what to do with adjusted_confidence.
 */
function applySessionFilter(instrument, rawConfidence, sessionObj) {
  if (!sessionObj.trades_allowed) {
    return {
      adjusted_confidence: 0,
      session_delta:       null,
      trade_blocked:       true,
      block_reason:        sessionObj.block_reason || `${sessionObj.session} — trading blocked`,
    };
  }

  const pairBonus  = (PAIR_SESSION_DELTA[instrument] || {})[sessionObj.session] ?? 0;
  const totalDelta = sessionObj.conf_delta + pairBonus;
  const adjusted   = Math.round(Math.max(0, Math.min(100, rawConfidence + totalDelta)));

  return {
    adjusted_confidence: adjusted,
    session_delta:       totalDelta,
    trade_blocked:       false,
    block_reason:        null,
  };
}

module.exports = { getCurrentSession, applySessionFilter, SESSIONS };
