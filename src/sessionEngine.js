'use strict';

/**
 * Session Engine — fixed UTC boundaries, 4 sessions
 *
 * LOW_LIQUIDITY : 21:00–23:00 UTC   (dead / rollover zone)
 * ASIA          : 23:00–07:00 UTC
 * LONDON        : 07:00–13:00 UTC
 * NEW_YORK      : 13:00–21:00 UTC
 *
 * Overlaps are NOT separate sessions — they are annotated zones inside
 * the containing session:
 *   London Open / Transition zone : 07:00–09:00 UTC  (inside LONDON)
 *   London/NY Overlap zone        : 13:00–16:00 UTC  (inside NEW_YORK)
 *
 * Weekend rule:
 *   Saturday 00:00 → Sunday 21:00 UTC  = LOW_LIQUIDITY (market closed)
 *   Sunday   21:00+ UTC                = LOW_LIQUIDITY (thin open, not tradeable)
 */

// ─── Session boundaries (UTC hours, inclusive open, exclusive close) ──────────

const SESSION_BOUNDARIES = [
  { session: 'ASIA',          open: 23, close: 7  }, // wraps midnight: 23:00–07:00
  { session: 'LONDON',        open: 7,  close: 13 },
  { session: 'NEW_YORK',      open: 13, close: 21 },
  { session: 'LOW_LIQUIDITY', open: 21, close: 23 }, // 21:00–23:00
];

// Zones annotated inside their parent session (informational only)
const SESSION_ZONES = {
  LONDON:   [{ name: 'LONDON_OPEN',  open: 7,  close: 9  }],
  NEW_YORK: [{ name: 'NY_OVERLAP',   open: 13, close: 16 }],
};

// ─── Session metadata ─────────────────────────────────────────────────────────

const SESSION_META = {
  LOW_LIQUIDITY: { label: 'Low Liquidity', quality: 'BLOCKED',   tradesAllowed: false, baseActivity: 5  },
  ASIA:          { label: 'Asia',          quality: 'MEDIUM',    tradesAllowed: true,  baseActivity: 48 },
  LONDON:        { label: 'London',        quality: 'HIGH',      tradesAllowed: true,  baseActivity: 80 },
  NEW_YORK:      { label: 'New York',      quality: 'HIGH',      tradesAllowed: true,  baseActivity: 85 },
};

// ─── Quality config ───────────────────────────────────────────────────────────

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

// ─── Pair-session activity deltas (kept for signal confidence adjustment) ─────

const PAIR_SESSION_DELTA = {
  GBP_USD: { LONDON: +8, NEW_YORK: +6, ASIA: -5 },
  GBP_JPY: { LONDON: +8, NEW_YORK: +5, ASIA: +3 },
  GBP_CHF: { LONDON: +8, NEW_YORK: +4, ASIA: -3 },
  GBP_CAD: { LONDON: +8, NEW_YORK: +6, ASIA: -3 },
  GBP_AUD: { LONDON: +8, ASIA: -5 },
  GBP_NZD: { LONDON: +8, ASIA: -5 },
  EUR_USD:  { LONDON: +5, NEW_YORK: +8, ASIA: -3 },
  EUR_JPY:  { LONDON: +5, NEW_YORK: +6 },
  EUR_GBP:  { LONDON: +8, NEW_YORK: +4, ASIA: -5 },
  EUR_CHF:  { LONDON: +5 },
  EUR_CAD:  { NEW_YORK: +7, LONDON: +5 },
  EUR_AUD:  { LONDON: +5, NEW_YORK: +4 },
  EUR_NZD:  { LONDON: +5, NEW_YORK: +4 },
  USD_JPY:  { NEW_YORK: +7, LONDON: +3, ASIA: +5 },
  USD_CHF:  { NEW_YORK: +7, LONDON: +3 },
  USD_CAD:  { NEW_YORK: +9 },
  AUD_USD:  { ASIA: +8, NEW_YORK: +4 },
  NZD_USD:  { ASIA: +8, NEW_YORK: +4 },
  AUD_NZD:  { ASIA: +10, LONDON: -3, NEW_YORK: -3 },
  AUD_JPY:  { ASIA: +8, LONDON: +5, NEW_YORK: +4 },
  NZD_JPY:  { ASIA: +8, LONDON: +5, NEW_YORK: +4 },
  CAD_CHF:  { NEW_YORK: +7, LONDON: +3 },
  CAD_JPY:  { NEW_YORK: +7, LONDON: +3, ASIA: +3 },
  CHF_JPY:  { LONDON: +5, ASIA: +3 },
};

// ─── Core session detection ───────────────────────────────────────────────────

function getCurrentSession(now = new Date()) {
  const utcHour = now.getUTCHours();
  const day     = now.getUTCDay(); // 0=Sun … 6=Sat

  // Weekend: Saturday all day + Sunday before 21:00 UTC
  if (day === 6 || (day === 0 && utcHour < 21)) {
    return _build('LOW_LIQUIDITY', now, { blocked: true, blockReason: 'Market closed — weekend' });
  }

  const sessName = _sessionForHour(utcHour);
  const blocked  = sessName === 'LOW_LIQUIDITY';
  return _build(sessName, now, blocked ? { blocked: true, blockReason: 'Low liquidity — rollover zone' } : {});
}

function _sessionForHour(utcHour) {
  for (const b of SESSION_BOUNDARIES) {
    if (b.open < b.close) {
      // Normal range (e.g. LONDON 7–13)
      if (utcHour >= b.open && utcHour < b.close) return b.session;
    } else {
      // Wraps midnight (e.g. ASIA 23–07)
      if (utcHour >= b.open || utcHour < b.close) return b.session;
    }
  }
  return 'LOW_LIQUIDITY';
}

// Returns the active zone name within a session (or null)
function getSessionZone(session, utcHour) {
  const zones = SESSION_ZONES[session] || [];
  const z = zones.find(z => utcHour >= z.open && utcHour < z.close);
  return z?.name || null;
}

// ─── Build session result ─────────────────────────────────────────────────────

function _build(sessName, now, opts = {}) {
  const meta          = SESSION_META[sessName] || SESSION_META.LOW_LIQUIDITY;
  const quality       = meta.quality;
  const tradesAllowed = opts.blocked != null ? !opts.blocked : meta.tradesAllowed;
  const utcHour       = now.getUTCHours();
  const zone          = tradesAllowed ? getSessionZone(sessName, utcHour) : null;

  const b = SESSION_BOUNDARIES.find(x => x.session === sessName);

  let activityIndex = tradesAllowed ? meta.baseActivity : 0;
  if (tradesAllowed && b) {
    const duration = b.open < b.close ? (b.close - b.open) : (24 - b.open + b.close);
    const elapsed  = utcHour >= b.open ? (utcHour - b.open) : (24 - b.open + utcHour);
    const progress = Math.max(0, Math.min(1, elapsed / (duration || 1)));
    const ramp     = Math.sin(progress * Math.PI);
    activityIndex  = Math.round(Math.max(5, meta.baseActivity * 0.75 + meta.baseActivity * 0.25 * ramp));
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
    zone,                            // e.g. 'NY_OVERLAP', 'LONDON_OPEN', or null
    start_hour:      b?.open  ?? null,
    end_hour:        b?.close ?? null,
    utc_hour:        utcHour,
    utc_day:         now.getUTCDay(),
    time:            now.toISOString(),
  };
}

// ─── Session timeline for dashboard ──────────────────────────────────────────

function getSessionTimeline(now = new Date()) {
  const current = getCurrentSession(now);
  return SESSION_BOUNDARIES.map(b => ({
    name:      b.session,
    label:     SESSION_META[b.session]?.label || b.session,
    quality:   (SESSION_META[b.session]?.quality || 'MEDIUM').toLowerCase().replace(/_/g, '-'),
    startHour: b.open,
    endHour:   b.close,
    isCurrent: b.session === current.session,
  }));
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

module.exports = { getCurrentSession, applySessionFilter, getSessionTimeline, getSessionZone, SESSION_BOUNDARIES, SESSION_META };
