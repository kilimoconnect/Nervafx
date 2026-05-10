'use strict';

/**
 * Phase 10 — Trading Session Engine (DST-aware)
 *
 * Sessions are defined in LOCAL timezone hours (Europe/London, America/New_York).
 * UTC ranges are computed dynamically via Intl, so London BST/GMT and NY EDT/EST
 * shifts are handled automatically — including the weeks where they diverge.
 *
 * Standard overlap (both winter):  13:00–17:00 UTC
 * NY switches to EDT before London: 12:00–17:00 UTC
 * Both on summer time:              12:00–16:00 UTC
 * London reverts before NY:         13:00–16:00 UTC  ← the "weird week"
 */

// ─── Timezone helpers ─────────────────────────────────────────────────────────

/**
 * Returns the current local hour (0–23) in a given IANA timezone.
 */
function getLocalHour(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour:     '2-digit',
    hour12:   false,
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  return h === 24 ? 0 : h; // some engines return 24 for midnight
}

/**
 * Returns the UTC offset in whole hours for a timezone at a given moment.
 * e.g. BST → +1,  GMT → 0,  EDT → -4,  EST → -5
 */
function getUTCOffset(timezone, date = new Date()) {
  const utcHour   = date.getUTCHours();
  const localHour = getLocalHour(timezone, date);
  let offset = localHour - utcHour;
  if (offset >  12) offset -= 24;
  if (offset < -12) offset += 24;
  return offset;
}

/**
 * Converts a local session hour to its UTC equivalent for today.
 */
function localToUTC(localHour, utcOffset) {
  return ((localHour - utcOffset) % 24 + 24) % 24;
}

// ─── Quality definitions ──────────────────────────────────────────────────────

const QUALITY_CONF_DELTA = {
  VERY_HIGH: +10,
  HIGH:      +5,
  MEDIUM:    0,
  LOW:       -10,
  BLOCKED:   -999,
};

const QUALITY_DESC = {
  VERY_HIGH: 'Continuation & breakouts highly favoured',
  HIGH:      'Good conditions for continuation trades',
  MEDIUM:    'Moderate participation — JPY/AUD/NZD pairs preferred',
  LOW:       'Thin liquidity — reduce size, avoid new entries',
  BLOCKED:   'Trading not permitted this session',
};

// ─── Session static metadata ──────────────────────────────────────────────────
// localOpen/localClose = hours in the session's primary timezone

const SESSION_META = {
  DEAD_HOURS:  { label: 'Low Liquidity',      quality: 'BLOCKED',   tradesAllowed: false, baseActivity: 5,  tz: null,                 localOpen: null, localClose: null },
  PRE_LONDON:  { label: 'Pre-London',         quality: 'LOW',       tradesAllowed: true,  baseActivity: 22, tz: 'Europe/London',       localOpen: 6,    localClose: 8    },
  ASIA:        { label: 'Asia',               quality: 'MEDIUM',    tradesAllowed: true,  baseActivity: 48, tz: 'Asia/Tokyo',          localOpen: 9,    localClose: 18   },
  LONDON_OPEN: { label: 'London Open',        quality: 'HIGH',      tradesAllowed: true,  baseActivity: 80, tz: 'Europe/London',       localOpen: 8,    localClose: 10   },
  LONDON:      { label: 'London',             quality: 'HIGH',      tradesAllowed: true,  baseActivity: 70, tz: 'Europe/London',       localOpen: 10,   localClose: 13   },
  LONDON_NY:   { label: 'London/NY Overlap',  quality: 'VERY_HIGH', tradesAllowed: true,  baseActivity: 92, tz: 'Europe/London',       localOpen: 13,   localClose: 17   },
  LATE_NY:     { label: 'Late NY',            quality: 'LOW',       tradesAllowed: true,  baseActivity: 28, tz: 'America/New_York',    localOpen: 8,    localClose: 17   },
};

// ─── Pair-session deltas ───────────────────────────────────────────────────────

const PAIR_SESSION_DELTA = {
  GBP_USD: { LONDON_OPEN: +8, LONDON: +5, LONDON_NY: +8, LATE_NY: -5, ASIA: -5, PRE_LONDON: -3 },
  GBP_JPY: { LONDON_OPEN: +8, LONDON: +5, LONDON_NY: +8, ASIA: +3,   LATE_NY: -5 },
  GBP_CHF: { LONDON_OPEN: +8, LONDON: +5, LONDON_NY: +5, ASIA: -3 },
  GBP_CAD: { LONDON_OPEN: +8, LONDON: +5, LONDON_NY: +8, ASIA: -3 },
  GBP_AUD: { LONDON_OPEN: +8, LONDON: +5, ASIA: -5 },
  GBP_NZD: { LONDON_OPEN: +8, LONDON: +5, ASIA: -5 },
  EUR_USD:  { LONDON: +5, LONDON_NY: +10, LONDON_OPEN: +5, ASIA: -3 },
  EUR_JPY:  { LONDON: +5, LONDON_NY:  +8, LONDON_OPEN: +5 },
  EUR_GBP:  { LONDON: +8, LONDON_OPEN: +8, LONDON_NY: +5, ASIA: -5 },
  EUR_CHF:  { LONDON: +5, LONDON_OPEN: +5 },
  EUR_CAD:  { LONDON_NY: +8, LONDON: +5 },
  EUR_AUD:  { LONDON: +5, LONDON_NY: +5 },
  EUR_NZD:  { LONDON: +5, LONDON_NY: +5 },
  USD_JPY:  { LONDON_NY: +8, LONDON: +3, ASIA: +5 },
  USD_CHF:  { LONDON_NY: +8, LONDON: +3 },
  USD_CAD:  { LONDON_NY: +10, LATE_NY: +3 },
  AUD_USD:  { ASIA: +8, LONDON_NY: +5 },
  NZD_USD:  { ASIA: +8, LONDON_NY: +5 },
  AUD_NZD:  { ASIA: +10, LONDON: -3, LONDON_NY: -3 },
  AUD_JPY:  { ASIA: +8,  LONDON: +5, LONDON_NY: +5 },
  NZD_JPY:  { ASIA: +8,  LONDON: +5, LONDON_NY: +5 },
  CAD_CHF:  { LONDON_NY: +8, LONDON: +3 },
  CAD_JPY:  { LONDON_NY: +8, LONDON: +3, ASIA: +3 },
  CHF_JPY:  { LONDON: +5, LONDON_OPEN: +5, ASIA: +3 },
};

// ─── Core session detection ───────────────────────────────────────────────────

function getCurrentSession(now = new Date()) {
  const day = now.getUTCDay(); // 0=Sun … 6=Sat

  // ── Weekend blocks ───────────────────────────────────────────────────────
  if (day === 6) {
    return _build('DEAD_HOURS', now, { blocked: true, blockReason: 'Market closed — weekend' });
  }
  if (day === 0) {
    const utcHour = now.getUTCHours();
    if (utcHour < 22) {
      return _build('DEAD_HOURS', now, { blocked: true, blockReason: 'Market not yet open — Sydney opens ~22:00 UTC' });
    }
    // 22:00+ Sunday: Sydney thin open (counts as low-quality Asia)
    return _build('ASIA', now, { qualityOverride: 'LOW', activityOverride: 18 });
  }

  // ── Live local hours for key centres ────────────────────────────────────
  const londonHour = getLocalHour('Europe/London',    now);
  const nyHour     = getLocalHour('America/New_York', now);
  const tokyoHour  = getLocalHour('Asia/Tokyo',       now);

  const londonOpen = londonHour >= 8  && londonHour < 17;
  const nyOpen     = nyHour     >= 8  && nyHour     < 17;
  const tokyoOpen  = tokyoHour  >= 9  && tokyoHour  < 18;

  // ── Rollover: first hour after NY close (DST-aware: ~21 or 22 UTC) ──────
  // Defined as NY 17:00–18:00 local, regardless of season.
  if (nyHour >= 17 && nyHour < 18) {
    return _build('DEAD_HOURS', now, {
      blocked:     true,
      blockReason: `Rollover — NY close ${nyHour}:00 local`,
    });
  }

  // Post-rollover, pre-Tokyo dead zone (NY 18:00+ and nothing else open)
  if (!londonOpen && !nyOpen && !tokyoOpen) {
    return _build('DEAD_HOURS', now, { blocked: true, blockReason: 'Low liquidity — all major centres closed' });
  }

  // ── Active session priority ──────────────────────────────────────────────
  // LONDON + NY both open → best window (DST-aware overlap)
  if (londonOpen && nyOpen) {
    return _build('LONDON_NY', now);
  }

  // London only
  if (londonOpen) {
    return _build(londonHour < 10 ? 'LONDON_OPEN' : 'LONDON', now);
  }

  // NY only (London already closed)
  if (nyOpen) {
    return _build('LATE_NY', now);
  }

  // Asia (Tokyo)
  if (tokyoOpen) {
    return _build('ASIA', now);
  }

  // London approaching (pre-session warm-up)
  if (londonHour >= 6 && londonHour < 8) {
    return _build('PRE_LONDON', now);
  }

  // Fallback
  return _build('DEAD_HOURS', now, { blocked: true, blockReason: 'Dead hours — low liquidity' });
}

// ─── Build session result ─────────────────────────────────────────────────────

function _build(sessName, now, opts = {}) {
  const meta         = SESSION_META[sessName] || SESSION_META.DEAD_HOURS;
  const quality      = opts.qualityOverride  || meta.quality;
  const baseActivity = opts.activityOverride ?? meta.baseActivity;
  const tradesAllowed = opts.blocked != null ? !opts.blocked : meta.tradesAllowed;

  // DST-aware UTC range for display
  const loOffset = getUTCOffset('Europe/London',    now);
  const nyOffset = getUTCOffset('America/New_York', now);

  const utcRange = _computeUTCRange(sessName, loOffset, nyOffset);

  // Detect whether DST is in effect (differs from canonical winter times)
  const canonicalLoOffset = 0;  // London winter = UTC+0
  const canonicalNyOffset = -5; // NY winter = UTC-5
  const dstActive = loOffset !== canonicalLoOffset || nyOffset !== canonicalNyOffset;

  // Activity ramp (sin arc within session window)
  let activityIndex = tradesAllowed ? baseActivity : 0;
  if (tradesAllowed && utcRange) {
    const duration = ((utcRange.close - utcRange.open) + 24) % 24 || 1;
    const elapsed  = ((now.getUTCHours() - utcRange.open) + 24) % 24;
    const progress = Math.max(0, Math.min(1, elapsed / duration));
    const ramp     = Math.sin(progress * Math.PI);
    activityIndex  = Math.round(Math.max(5, baseActivity * 0.75 + baseActivity * 0.25 * ramp));
  }

  return {
    session:         sessName,
    label:           meta.label,
    quality,
    quality_desc:    QUALITY_DESC[quality] || '',
    trades_allowed:  tradesAllowed,
    block_reason:    opts.blockReason || null,
    activity_index:  activityIndex,
    conf_delta:      tradesAllowed ? (QUALITY_CONF_DELTA[quality] ?? 0) : -999,
    start_hour:      utcRange?.open  ?? null,
    end_hour:        utcRange?.close ?? null,
    dst_active:      dstActive,
    london_offset:   loOffset,
    ny_offset:       nyOffset,
    utc_hour:        now.getUTCHours(),
    utc_day:         now.getUTCDay(),
    time:            now.toISOString(),
  };
}

function _computeUTCRange(sessName, loOffset, nyOffset) {
  const n = h => ((Math.round(h) % 24 + 24) % 24); // normalize to 0–23

  switch (sessName) {
    case 'ASIA':        return { open: 0,           close: 9 };           // Tokyo UTC+9, no DST
    case 'PRE_LONDON':  return { open: n(6 - loOffset),  close: n(8  - loOffset) };
    case 'LONDON_OPEN': return { open: n(8 - loOffset),  close: n(10 - loOffset) };
    case 'LONDON':      return { open: n(10 - loOffset), close: n(13 - loOffset) };
    case 'LONDON_NY':   return {
      open:  n(Math.max(8 - loOffset, 8 - nyOffset)),   // later  of London & NY open
      close: n(Math.min(17 - loOffset, 17 - nyOffset)), // earlier of London & NY close
    };
    case 'LATE_NY':     return { open: n(13 - nyOffset), close: n(17 - nyOffset) };
    default:            return null;
  }
}

// ─── Session timeline for dashboard ──────────────────────────────────────────
/**
 * Returns an array of display sessions with dynamic UTC ranges.
 * Used by the dashboard timeline and api/session.js.
 */
function getSessionTimeline(now = new Date()) {
  const loOffset = getUTCOffset('Europe/London',    now);
  const nyOffset = getUTCOffset('America/New_York', now);
  const current  = getCurrentSession(now);

  return [
    'ASIA', 'LONDON_OPEN', 'LONDON', 'LONDON_NY', 'LATE_NY', 'DEAD_HOURS',
  ].map(name => {
    const meta  = SESSION_META[name];
    const range = _computeUTCRange(name, loOffset, nyOffset);
    return {
      name,
      label:     meta.label,
      quality:   meta.quality.toLowerCase().replace(/_/g, '-'),
      startHour: range?.open  ?? null,
      endHour:   range?.close ?? null,
      isCurrent: name === current.session,
    };
  });
}

// ─── Apply session filter to a pair ──────────────────────────────────────────

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

module.exports = { getCurrentSession, applySessionFilter, getSessionTimeline };
