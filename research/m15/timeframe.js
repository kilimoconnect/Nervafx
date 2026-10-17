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

module.exports = { INTERVAL_MS, CANDLES_PER_HOUR, DB: 'H1', LABEL: 'H1' };
