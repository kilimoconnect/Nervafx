'use strict';

/**
 * NervaFX H1 Continuation Engine — SESSION mode constants (isolated).
 *
 * Fully separate from the Generic engine (_h1c-constants.js). Detects a late New
 * York move → Asia pause/pullback → failure → second push (Asia or London).
 * All thresholds are centralised here — no magic numbers elsewhere.
 */

const HOUR_MS = 60 * 60 * 1000;

const MODE = 'session_h1_continuation';
const GENERIC_MODE = 'generic_h1_continuation';

// Fixed EAT analytical window — never shifted by US DST.
const EAT_TZ = 'Africa/Dar_es_Salaam';
const LONDON_TZ = 'Europe/London';
const SESSION_START_HOUR = 17;   // 17:00 EAT
const SESSION_END_HOUR = 23;     // 23:00 EAT
const SESSION_CANDLES = 6;       // 17:00–23:00 = six completed H1 candles
const LONDON_OPEN_HOUR = 8;      // 08:00 Europe/London

// Reference-move qualification (configurable).
const SESSION_ATR_PERIOD = 20;
const SESSION_MIN_MOVE_ATR = 1.00;
const SESSION_MIN_EFFICIENCY = 0.60;
const SESSION_MIN_DIRECTIONAL_CANDLES = 4;
const SESSION_MIN_CLOSE_QUALITY = 0.70;

// Pause / pullback bands (fraction of the reference move).
const RETRACE_PAUSE_MAX = 0.20;        // < 20% = PAUSE
const RETRACE_CONTROLLED_MAX = 0.60;   // 20–60% = CONTROLLED_PULLBACK, > 60% = DEEP

// Failure / second-push.
const FAILURE_EXTENSION_BUFFER_ATR = 0.10;   // "no material new extreme" tolerance
const CONFIRM_BUFFER_ATR = 0.05;             // break buffer on the failure box
const CONTINUATION_FORCE_ATR = 0.30;         // second-push break-candle body ≥ this × ATR
const OPPOSITE_IMPULSE_ATR = 1.20;           // strong opposite move → invalidation
const MIN_POST_SESSION_CANDLES = 2;          // earliest continuation after 2 post-session candles
const MIN_H1_HISTORY = 30;                   // ATR20 warm-up + the six session candles

const STATES = Object.freeze({
  SEARCHING_REFERENCE_SESSION: 'SEARCHING_REFERENCE_SESSION',
  REFERENCE_SESSION_LOCKED: 'REFERENCE_SESSION_LOCKED',
  POST_SESSION_PAUSE: 'POST_SESSION_PAUSE',
  POST_SESSION_PULLBACK: 'POST_SESSION_PULLBACK',
  SECOND_PUSH_READY: 'SECOND_PUSH_READY',
  SECOND_PUSH_STARTED: 'SECOND_PUSH_STARTED',
  SESSION_CONTINUATION_CONFIRMED: 'SESSION_CONTINUATION_CONFIRMED',
  INVALIDATED: 'INVALIDATED',
  EXPIRED: 'EXPIRED',
});
const STATE_LIST = Object.freeze(Object.values(STATES));

// Failure is a CONDITION within the active post-session state, not a stored state.
const FAILURE_STATUS = Object.freeze({ NONE: 'NONE', DEVELOPING: 'DEVELOPING', CONFIRMED: 'CONFIRMED' });
const PHASE = Object.freeze({ ASIA: 'ASIA', LONDON: 'LONDON' });
const PAUSE_TYPE = Object.freeze({ PAUSE: 'PAUSE', CONTROLLED_PULLBACK: 'CONTROLLED_PULLBACK', DEEP_PULLBACK: 'DEEP_PULLBACK' });

// Reference-session rejection reasons.
const REJECTIONS = Object.freeze({
  MISSING_CANDLES: 'MISSING_CANDLES',
  INCOMPLETE: 'INCOMPLETE',
  DUP_OR_UNORDERED: 'DUP_OR_UNORDERED',
  DATA_GAP: 'DATA_GAP',
  CROSS_DATE: 'CROSS_DATE',
  FRIDAY_NO_CONTINUATION: 'FRIDAY_NO_CONTINUATION',
});
const INVALIDATION = Object.freeze({
  STRUCTURE_BREAK: 'STRUCTURE_BREAK',
  DEEP_PULLBACK: 'DEEP_PULLBACK',
  OPPOSITE_IMPULSE: 'OPPOSITE_IMPULSE',
  EXPIRED_NO_CONTINUATION: 'EXPIRED_NO_CONTINUATION',
});

const ENGINE_VERSION = 'h1cs-1.0.0';
const CONFIGURATION_VERSION = 'h1cs-config-1';

module.exports = {
  HOUR_MS, MODE, GENERIC_MODE,
  EAT_TZ, LONDON_TZ, SESSION_START_HOUR, SESSION_END_HOUR, SESSION_CANDLES, LONDON_OPEN_HOUR,
  SESSION_ATR_PERIOD, SESSION_MIN_MOVE_ATR, SESSION_MIN_EFFICIENCY, SESSION_MIN_DIRECTIONAL_CANDLES, SESSION_MIN_CLOSE_QUALITY,
  RETRACE_PAUSE_MAX, RETRACE_CONTROLLED_MAX,
  FAILURE_EXTENSION_BUFFER_ATR, CONFIRM_BUFFER_ATR, CONTINUATION_FORCE_ATR, OPPOSITE_IMPULSE_ATR,
  MIN_POST_SESSION_CANDLES, MIN_H1_HISTORY,
  STATES, STATE_LIST, FAILURE_STATUS, PHASE, PAUSE_TYPE, REJECTIONS, INVALIDATION,
  ENGINE_VERSION, CONFIGURATION_VERSION,
};
