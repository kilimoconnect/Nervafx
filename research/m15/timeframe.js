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

// The four nested context windows are a CONSTANT span of TIME across timeframes
// (24 / 36 / 48 / 72 hours), so the labels always read the real window length. The
// candle count per window then follows the timeframe:
//   M15 (4/h) → 96/144/192/288 candles ;  H1 (1/h) → 24/36/48/72 candles.
const WINDOW_HOURS = [24, 36, 48, 72];
const WINDOW_CANDLES = WINDOW_HOURS.map((h) => h * CANDLES_PER_HOUR);
const BLOCK_HOURS = WINDOW_HOURS[0];           // non-overlapping block size (= smallest window)
const PRIMARY_HOURS = WINDOW_HOURS[1];         // the "primary" window used for leave-one-pair-out
const hoursLabel = (h) => h + 'h';             // always hours (12h, 24h, …), never collapsed to days
const WINDOW_LABELS = WINDOW_HOURS.map(hoursLabel);

module.exports = { INTERVAL_MS, CANDLES_PER_HOUR, DB: 'H1', LABEL: 'H1', WINDOW_CANDLES, WINDOW_HOURS, WINDOW_LABELS, BLOCK_HOURS, PRIMARY_HOURS, hoursLabel };
