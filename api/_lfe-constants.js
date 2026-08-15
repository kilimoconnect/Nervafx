'use strict';

/**
 * NervaFX Liquidity Failure Engine — single versioned configuration + enums.
 *
 * All adjustable parameters live here. No magic numbers elsewhere in the engine.
 * Fully isolated: imports nothing from Sharp Reversal, Second Push, or any other
 * engine. H1 + M15 only, price data only.
 */

const HOUR_MS = 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;

// 28-pair universe (provider underscore format base_quote), matching backtest_candles.
const PAIRS = Object.freeze([
  'AUD_CAD', 'AUD_CHF', 'AUD_JPY', 'AUD_NZD', 'AUD_USD',
  'CAD_CHF', 'CAD_JPY',
  'CHF_JPY',
  'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'EUR_USD',
  'GBP_AUD', 'GBP_CAD', 'GBP_CHF', 'GBP_JPY', 'GBP_NZD', 'GBP_USD',
  'NZD_CAD', 'NZD_CHF', 'NZD_JPY', 'NZD_USD',
  'USD_CAD', 'USD_CHF', 'USD_JPY',
]);

// The one versioned configuration object.
const CONFIG = Object.freeze({
  version: 'lfe-config-v1',
  atr: { h1Period: 14, m15Period: 14 },
  ema: { h1Periods: [20, 50] },
  history: { minH1: 300, minM15: 500 },
  zone: { atrMultiplier: 0.05, maxWidthAtr: 0.15, equalLevelTolAtr: 0.10 },
  pivot: { h1Left: 2, h1Right: 2, m15Left: 2, m15Right: 2 },
  attack: {
    lookbackMin: 1, lookbackMax: 6, minDistanceAtr: 0.80,
    strongBodyAtr: 0.45,           // "one bullish body of at least 0.45 ATR"
    breakoutBodyAtr: 0.50, breakoutBodyRatio: 0.55, // "a strong breakout candle"
  },
  failure: {
    minRangeAtr: 0.60,
    immediate: { closeLocSell: 0.40, closeLocBuy: 0.60 },
    breakout: { closeLocSell: 0.60, closeLocBuy: 0.40 }, // delayed breakout / breakdown
    return: { bodyRatio: 0.40, closeLocSell: 0.45, closeLocBuy: 0.55 },
    strong: { bodyAtr: 0.50, bodyRatio: 0.55, closeLocSell: 0.35, closeLocBuy: 0.65 },
    delayedWindow: 2,
    points: { returnNext: 10, returnSecond: 6, strongBonus: 4 },
  },
  delayedFailure: { windowH1: 2 },
  m15Confirm: {
    windowCandles: 8, lookbackPivots: 16, bufferAtr: 0.03,
    minBodyAtr: 0.35, minBodyRatio: 0.50, closeLocSell: 0.35, closeLocBuy: 0.65,
  },
  signal: { trendAlignedThreshold: 75, counterTrendThreshold: 85 },
  score: {
    weights: { level: 15, attack: 10, failure: 25, m15: 25, ema: 10, rotation: 10, context: 5 },
    aplus: 85, confirmed: 75, watch: 65,
    rotationScale: 2.0,           // strength-delta units mapping to full rotation points
  },
  risk: { stopAtr: 0.10, lateR: 0.50, entryExpiryCandles: 4 },
  targets: { defaultR: 2, minRewardR: 1.5 },   // analytical only — never execution.
  backtest: { spread: 0, slippage: 0, maxHoldCandles: 96, batchPairs: 7, stepMs: 15 * 60 * 1000 },
  validation: { pairDominancePct: 0.20, periodDominancePct: 0.40, minSample: 20, countertrendWorseR: 0.20 },
  swing: { reactionAtr: 0.75 },                // major-pivot reaction threshold
  equal: { minTouchSeparation: 3 },            // H1 candles between equal-level touches
  merge: { atrMultiplier: 0.15 },              // overlap-merge tolerance
});

// ── Enums (runtime-frozen; CommonJS has no static types) ─────────────────────
const FAILED_SIDE = Object.freeze({ BUYERS: 'BUYERS', SELLERS: 'SELLERS' });
const DIRECTION = Object.freeze({ BUY: 'BUY', SELL: 'SELL' });
const SETUP_TYPE = Object.freeze({ IMMEDIATE: 'IMMEDIATE', DELAYED: 'DELAYED' });
const LEVEL_TYPE = Object.freeze({
  SWING_HIGH: 'SWING_HIGH', SWING_LOW: 'SWING_LOW',
  EQUAL_HIGHS: 'EQUAL_HIGHS', EQUAL_LOWS: 'EQUAL_LOWS',
  PREV_DAY_HIGH: 'PREV_DAY_HIGH', PREV_DAY_LOW: 'PREV_DAY_LOW',
});
const ORIENTATION = Object.freeze({ RESISTANCE: 'resistance', SUPPORT: 'support' });
const LEVEL_STATE = Object.freeze({
  ACTIVE: 'ACTIVE', BREACHED: 'BREACHED', ACCEPTED: 'ACCEPTED',
  FAILED: 'FAILED', EXPIRED: 'EXPIRED',
});
// Starting level-quality scores (Portion 3E).
const LEVEL_SCORES = Object.freeze({
  EQUAL_3PLUS: 15, EQUAL_2: 14, PREV_DAY: 13, SWING_MAJOR: 12, SWING_MINOR: 8,
});
const ENGINE_STATE = Object.freeze({
  SEARCHING: 'SEARCHING',
  LEVEL_MARKED: 'LEVEL_MARKED',
  ATTACK: 'ATTACK',
  FAILURE_CONFIRMED: 'FAILURE_CONFIRMED',
  MSS_PENDING: 'MSS_PENDING',
  SIGNAL_CONFIRMED: 'SIGNAL_CONFIRMED',
  INVALIDATED: 'INVALIDATED',
  EXPIRED: 'EXPIRED',
});
// Per-event lifecycle states for H1 failures.
const EVENT_STATE = Object.freeze({
  DELAYED_FAILURE_PENDING: 'DELAYED_FAILURE_PENDING',
  FAILURE_CONFIRMED: 'FAILURE_CONFIRMED',
  ACCEPTED: 'ACCEPTED',
  EXPIRED: 'EXPIRED',
});
// M15 confirmation outcome.
const MSS_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED', WAITING: 'WAITING', UNCONFIRMED: 'UNCONFIRMED',
  PENDING: 'PENDING', INVALIDATED: 'INVALIDATED', EXPIRED: 'EXPIRED',
});
const SIGNAL_CLASS = Object.freeze({ TREND_ALIGNED: 'TREND_ALIGNED', COUNTERTREND: 'COUNTERTREND' });
const SIGNAL_GRADE = Object.freeze({
  APLUS: 'A+', CONFIRMED: 'CONFIRMED', WATCH: 'WATCH', REJECTED: 'REJECTED',
});
const EVAL_MODE = Object.freeze({ LATEST_AVAILABLE: 'latest_available', HISTORICAL: 'historical' });

const DAY_MS = 24 * 60 * 60 * 1000;

// Fetch depths for a snapshot (H1 needs 300 history, M15 needs 500 + confirmation window).
const FETCH_LIMITS = Object.freeze({ h1: 400, m15: 650, d1: 15 });

// Display timezones offered by the replay UI (presentation only; storage is UTC).
const DISPLAY_TIMEZONES = Object.freeze([
  'UTC', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney',
]);

module.exports = {
  HOUR_MS, M15_MS, DAY_MS, FETCH_LIMITS, DISPLAY_TIMEZONES, PAIRS, CONFIG,
  FAILED_SIDE, DIRECTION, SETUP_TYPE, LEVEL_TYPE, ORIENTATION, LEVEL_STATE, LEVEL_SCORES,
  ENGINE_STATE, EVENT_STATE, MSS_STATUS, SIGNAL_CLASS, SIGNAL_GRADE, EVAL_MODE,
};
