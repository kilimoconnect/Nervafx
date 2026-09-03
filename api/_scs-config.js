'use strict';

/**
 * NervaFX — D1–H4–H1 Structure Continuation System (SCS).
 * Section 1: shared models / enums and the single configuration source.
 *
 * Pure & deterministic. No DB, no network, no execution. Analytical / paper only:
 * this module family produces signals, paper orders and simulated trades as plain
 * data — it never places live orders.
 */

// ── Enums / models ───────────────────────────────────────────────────────────
const D1_DIRECTION = Object.freeze({ BULLISH: 'BULLISH', BEARISH: 'BEARISH', NEUTRAL: 'NEUTRAL' });

const H4_STATE = Object.freeze({
  NO_IMPULSE: 'NO_IMPULSE', IMPULSE_ACTIVE: 'IMPULSE_ACTIVE', PULLBACK_ACTIVE: 'PULLBACK_ACTIVE',
  EXPIRED: 'EXPIRED', INVALIDATED: 'INVALIDATED',
});

const H1_STATE = Object.freeze({
  WAITING_BOS: 'WAITING_BOS', ENTRY_PENDING: 'ENTRY_PENDING',
  ACTIVE: 'ACTIVE', COMPLETED: 'COMPLETED', REJECTED: 'REJECTED',
});

const MARKET_STATE = Object.freeze({
  NORMAL: 'NORMAL', FRIDAY_CUTOFF: 'FRIDAY_CUTOFF', WEEKEND_FROZEN: 'WEEKEND_FROZEN',
  MONDAY_REVALIDATION: 'MONDAY_REVALIDATION',
});

const DIRECTION = Object.freeze({ BUY: 'BUY', SELL: 'SELL' });

const SIGNAL_STATUS = Object.freeze({
  CANDIDATE: 'CANDIDATE', PENDING: 'PENDING', ACTIVE: 'ACTIVE',
  TARGET_HIT: 'TARGET_HIT', STOP_HIT: 'STOP_HIT', EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED', REJECTED: 'REJECTED', FROZEN: 'FROZEN',
});

const ORIGIN = Object.freeze({ CURRENT_DAY: 'CURRENT_DAY', PREVIOUS_DAY: 'PREVIOUS_DAY', FRIDAY_CARRY: 'FRIDAY_CARRY' });

// Machine-readable rejection / invalidation reasons (paired with human text below).
const REJECTION = Object.freeze({
  NONE: 'NONE',
  // structure / BOS
  NO_SWING: 'NO_SWING',
  NO_CLOSE_BEYOND_SWING: 'NO_CLOSE_BEYOND_SWING',
  PENETRATION_TOO_SMALL: 'PENETRATION_TOO_SMALL',
  BODY_TOO_SMALL: 'BODY_TOO_SMALL',
  CLOSE_LOCATION_WEAK: 'CLOSE_LOCATION_WEAK',
  RANGE_TOO_LARGE: 'RANGE_TOO_LARGE',
  WICK_ONLY_NO_CLOSE: 'WICK_ONLY_NO_CLOSE',
  // D1
  D1_NEUTRAL: 'D1_NEUTRAL',
  D1_PROTECTED_BROKEN: 'D1_PROTECTED_BROKEN',
  D1_CONFLICT: 'D1_CONFLICT',
  // H4
  H4_NO_IMPULSE: 'H4_NO_IMPULSE',
  H4_D1_MISALIGNED: 'H4_D1_MISALIGNED',
  H4_PROTECTED_BROKEN: 'H4_PROTECTED_BROKEN',
  H4_EXPIRED: 'H4_EXPIRED',
  H4_OPPOSITE_STRUCTURE: 'H4_OPPOSITE_STRUCTURE',
  H4_PULLBACK_SHALLOW: 'H4_PULLBACK_SHALLOW',
  H4_MOVE_COMPLETED: 'H4_MOVE_COMPLETED',
  // H1 trigger / candidate
  H1_NO_BOS: 'H1_NO_BOS',
  INSUFFICIENT_TARGET_ROOM: 'INSUFFICIENT_TARGET_ROOM',
  STOP_TOO_WIDE: 'STOP_TOO_WIDE',
  STOP_TOO_TIGHT_VS_SPREAD: 'STOP_TOO_TIGHT_VS_SPREAD',
  PENDING_EXPIRED: 'PENDING_EXPIRED',
  ENTRY_MISSED: 'ENTRY_MISSED',
  DUPLICATE_PER_IMPULSE: 'DUPLICATE_PER_IMPULSE',
  // risk / session
  SPREAD_TOO_WIDE: 'SPREAD_TOO_WIDE',
  MAX_POSITIONS: 'MAX_POSITIONS',
  MAX_OPEN_RISK: 'MAX_OPEN_RISK',
  CORRELATED_EXPOSURE: 'CORRELATED_EXPOSURE',
  FRIDAY_CUTOFF: 'FRIDAY_CUTOFF',
  WEEKEND_FROZEN: 'WEEKEND_FROZEN',
  NEWS_FILTER_UNAVAILABLE: 'NEWS_FILTER_UNAVAILABLE',
  HIGH_IMPACT_NEWS: 'HIGH_IMPACT_NEWS',
  MONDAY_GAP_INVALIDATED: 'MONDAY_GAP_INVALIDATED',
});

// Human-readable explanations, keyed by machine code.
const REJECTION_TEXT = Object.freeze({
  NONE: 'No rejection.',
  NO_SWING: 'No confirmed swing to break.',
  NO_CLOSE_BEYOND_SWING: 'Candle did not close beyond the confirmed swing.',
  PENETRATION_TOO_SMALL: 'Penetration beyond the swing is below the minimum ATR threshold.',
  BODY_TOO_SMALL: 'Candle body is below the minimum ATR threshold.',
  CLOSE_LOCATION_WEAK: 'Close is not within the required end of the candle range.',
  RANGE_TOO_LARGE: 'Candle range exceeds the maximum ATR threshold.',
  WICK_ONLY_NO_CLOSE: 'Price wicked beyond the swing but did not close beyond it — not a BOS.',
  D1_NEUTRAL: 'D1 direction is neutral (no confirmed directional BOS).',
  D1_PROTECTED_BROKEN: 'A completed D1 candle closed beyond the protected level.',
  D1_CONFLICT: 'D1 structure is conflicting or unresolved.',
  H4_NO_IMPULSE: 'No aligned H4 impulse is active.',
  H4_D1_MISALIGNED: 'H4 impulse no longer aligns with D1 direction.',
  H4_PROTECTED_BROKEN: 'H4 closed beyond the protected H4 level.',
  H4_EXPIRED: 'H4 impulse exceeded its 12-candle life.',
  H4_OPPOSITE_STRUCTURE: 'Opposite H4 structure invalidated the impulse.',
  H4_PULLBACK_SHALLOW: 'H4 pullback did not retrace the minimum ATR from the impulse extreme.',
  H4_MOVE_COMPLETED: 'The continuation move completed before an entry formed.',
  H1_NO_BOS: 'No valid H1 BOS beyond the most recent confirmed H1 pullback swing.',
  INSUFFICIENT_TARGET_ROOM: 'Less than 2R of room before the nearest opposing D1/H4 swing.',
  STOP_TOO_WIDE: 'Stop distance exceeds 1.50 H1 ATR.',
  STOP_TOO_TIGHT_VS_SPREAD: 'Stop distance is less than three times the current spread.',
  PENDING_EXPIRED: 'Retracement entry expired after three completed H1 candles.',
  ENTRY_MISSED: 'Price reached the 2R target before retracing to the entry.',
  DUPLICATE_PER_IMPULSE: 'A trade candidate already exists for this H4 impulse.',
  SPREAD_TOO_WIDE: 'Spread exceeds twice its normal value for this pair and hour.',
  MAX_POSITIONS: 'Maximum simultaneous positions reached.',
  MAX_OPEN_RISK: 'Maximum combined open risk reached.',
  CORRELATED_EXPOSURE: 'Correlated same-currency-direction exposure limit reached.',
  FRIDAY_CUTOFF: 'Inside the final four hours before Friday New York close — no new entries.',
  WEEKEND_FROZEN: 'Market is frozen for the weekend — no evaluation.',
  NEWS_FILTER_UNAVAILABLE: 'No high-impact news provider is configured.',
  HIGH_IMPACT_NEWS: 'Blocked by high-impact news filter.',
  MONDAY_GAP_INVALIDATED: 'Monday opening gap invalidated the frozen setup.',
});

// ── Single configuration source (v1) ─────────────────────────────────────────
const CONFIG = Object.freeze({
  version: 'scs_v1',

  // structure / BOS
  atrPeriod: 14,
  swingLeft: 2,
  swingRight: 2,
  bosPenetrationAtr: 0.10,     // minimum penetration beyond the swing, in ATR
  bosMinBodyAtr: 0.60,         // minimum candle body, in ATR
  bosCloseLocation: 0.25,      // close must be within the final 25% of the range
  bosMaxRangeAtr: 2.00,        // maximum total candle range, in ATR

  // H4
  h4MinPullbackAtr: 0.50,      // minimum pullback from the impulse extreme, in H4 ATR
  h4ImpulseLifeCandles: 12,    // completed H4 trading candles the impulse stays eligible

  // H1
  h1PendingLifeCandles: 3,     // completed H1 candles a retracement entry survives
  h1MaxStopAtr: 1.50,          // reject if stop distance exceeds this H1 ATR
  h1MinStopSpreadMult: 3,      // reject if stop distance < this * current spread
  h1StopBufferAtr: 0.10,       // extra buffer beyond the pullback swing, in H1 ATR

  // target
  targetR: 2,                  // fixed 2R

  // risk (paper / forward-test)
  riskDefaultPct: 0.25,        // default per-trade risk %
  riskMaxPct: 0.50,            // configurable validated maximum %
  maxCombinedOpenRiskPct: 1.0, // maximum combined open risk %
  maxOpenPositions: 2,         // maximum simultaneous positions
  spreadWideMult: 2,           // reject when spread exceeds this * normal value

  // Friday / weekend
  fridayNoEntryHours: 4,       // no new entries in the final N hours before Friday NY close

  // timeframes (ms)
  h1Ms: 60 * 60 * 1000,
  h4Ms: 4 * 60 * 60 * 1000,

  // calendar
  dayAnchorHour: 17,           // trading day aligns to 17:00 …
  dayAnchorTz: 'America/New_York',
  weeklyAlignmentDay: 5,       // Friday (0=Sun … 5=Fri)

  // display timezones
  displayTzDefault: 'Africa/Dar_es_Salaam',
  displayTzs: Object.freeze(['Africa/Dar_es_Salaam', 'UTC', 'America/New_York']),
});

module.exports = {
  D1_DIRECTION, H4_STATE, H1_STATE, MARKET_STATE, DIRECTION, SIGNAL_STATUS, ORIGIN,
  REJECTION, REJECTION_TEXT, CONFIG,
  rejectionText: (code) => REJECTION_TEXT[code] || code,
};
