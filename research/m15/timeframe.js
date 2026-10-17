'use strict';

/**
 * Single source of truth for the analysis timeframe.
 *
 * To switch timeframe, change CANDLES_PER_HOUR + DB here only:
 *   H1  → CANDLES_PER_HOUR = 1,  DB = 'H1'   (current)
 *   M15 → CANDLES_PER_HOUR = 4,  DB = 'M15'
 *
 * INTERVAL_MS is the candle interval; everything derives nominal candle counts from
 * CANDLES_PER_HOUR, and the loader reads DB as the backtest_candles `timeframe`.
 * (The `M15` names kept across the code now mean "one candle interval" of this timeframe.)
 */
const CANDLES_PER_HOUR = 1;                    // H1
const INTERVAL_MS = Math.round(60 / CANDLES_PER_HOUR) * 60 * 1000;   // 3,600,000 ms for H1

// The four nested context windows keep a CONSTANT candle depth across timeframes, so the
// analysis is equally data-rich on any timeframe. In hours = candles / candles-per-hour:
//   M15 (4/h) → [12, 24, 36, 48]h ;  H1 (1/h) → [48, 96, 144, 192]h (= 2/4/6/8 days)
const WINDOW_CANDLES = [48, 96, 144, 192];
const WINDOW_HOURS = WINDOW_CANDLES.map((c) => Math.round(c / CANDLES_PER_HOUR));
const BLOCK_HOURS = WINDOW_HOURS[0];           // non-overlapping block size (= smallest window)
const PRIMARY_HOURS = WINDOW_HOURS[1];         // the "primary" window used for leave-one-pair-out
const hoursLabel = (h) => (h % 24 === 0 ? h / 24 + 'd' : h + 'h');
const WINDOW_LABELS = WINDOW_HOURS.map(hoursLabel);

module.exports = { INTERVAL_MS, CANDLES_PER_HOUR, DB: 'H1', LABEL: 'H1', WINDOW_CANDLES, WINDOW_HOURS, WINDOW_LABELS, BLOCK_HOURS, PRIMARY_HOURS, hoursLabel };
