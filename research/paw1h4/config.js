'use strict';

/**
 * PA_W1_H4_CONTINUATION — strategy configuration (single source of truth).
 *
 * A NEW, ISOLATED research module. It does NOT import, touch, or weaken any M15
 * code or guards. Price-action only: completed raw OHLC candles, confirmed swings,
 * structural trend, pullback and continuation break. No EMA / MA / RSI / MACD /
 * ATR / smoothing / volume signals / currency-strength filters. Every decision is
 * deterministic (pure functions of candles + config), never LLM-generated.
 *
 * Timeframe boundaries (documented, DST-invariant by construction):
 *   • We anchor the calendar in UTC, not a broker session, so there is NO daylight
 *     saving ambiguity and aggregation is reproducible from stored H1 candles.
 *   • H4 bucket  = floor(ms / 4h) * 4h  → opens at 00,04,08,12,16,20 UTC.
 *   • W1 bucket  = the UTC week beginning Monday 00:00 UTC (Mon 00:00 → next Mon
 *     00:00). H4 nests cleanly in the UTC day (6×4h) which nests in the week.
 *   • A bucket is COMPLETE only once its end time has fully elapsed as-of t. We
 *     aggregate only real H1 candles that fall in the bucket — we never fabricate a
 *     missing sub-candle. A bucket with fewer H1 than its full quota is flagged
 *     `partial` (expected around weekends/holidays); the strategy may be told to
 *     skip partial buckets, but their high/low are still real (not invented).
 *   (A broker-session alignment, e.g. 17:00 New York, is a documented future option
 *    and would live here only — the rest of the module reads these constants.)
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const H1_MS = HOUR_MS;
const H4_MS = 4 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const PAIRS = [
  'AUD_CAD', 'AUD_CHF', 'AUD_JPY', 'AUD_NZD', 'AUD_USD', 'CAD_CHF', 'CAD_JPY', 'CHF_JPY',
  'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'EUR_USD', 'GBP_AUD',
  'GBP_CAD', 'GBP_CHF', 'GBP_JPY', 'GBP_NZD', 'GBP_USD', 'NZD_CAD', 'NZD_CHF', 'NZD_JPY',
  'NZD_USD', 'USD_CAD', 'USD_CHF', 'USD_JPY',
];

const CONFIG = {
  strategyId: 'PA_W1_H4_CONTINUATION',
  version: 'paw1h4-1.0.0',

  // Base timeframe we aggregate FROM (stored provider candles). H1 → H4, H1 → W1.
  baseTimeframe: 'H1',
  baseIntervalMs: H1_MS,

  // Confirmed-swing fractal (initial research definition — NOT optimized on returns):
  // a swing high's high strictly exceeds the highs of the `left` candles before and
  // `right` candles after; a swing low strictly undercuts the lows of the same
  // surrounding candles. Equal extremes do NOT qualify. Confirmation occurs only
  // when the `right`-th following candle closes.
  swing: { left: 2, right: 2 },

  // Continuation sequence / cancellation (UNVALIDATED research settings):
  expiryH4Bars: 30,          // EXPIRED: 30 completed H4 candles after FIRST_BREAK
  exitH4Bars: 30,            // simulated exit after 30 completed H4 candles if no level hit
  oneOpportunityPerEpisode: true,

  // Suggested-trade economics (hypothetical; mid-only unless real spreads supplied):
  minRewardRisk: 2.0,        // reject if estimated R:R after costs < 2:1
  equityRiskPct: 0.25,       // % of equity risked per trade (hypothetical sizing)
  maxPortfolioRiskPct: 2.0,  // configurable aggregate exposure cap (informational)

  // Instrument-aware execution buffer + costs, expressed in PRICE PIPS. One pip =
  // 0.0001 for most pairs, 0.01 for JPY quote pairs. Buffer is added beyond the
  // structural stop; costs are applied symmetrically to entry/exit in the sim.
  execution: {
    bufferPips: 2.0,         // execution buffer beyond the structural stop
    spreadPips: 1.2,         // round-turn modelled as spread at entry + at exit
    commissionPips: 0.0,     // per-side commission in pips (0 for most spot FX)
    slippagePips: 0.5,       // per-fill slippage
    financingPipsPerBar: 0.0, // overnight financing per held H4 bar (0 = ignore; set to estimate)
    // Conservative rule when stop and target are both inside one H4 candle and the
    // intrabar order is unknown: assume the STOP was hit first. Reported per trade.
    stopFirstOnAmbiguity: true,
  },

  // Data-quality: a W1/H4 bucket with fewer than its full H1 quota is `partial`.
  // The engine records coverage and, when `requireFullBuckets` is true, excludes
  // partial buckets from swing sequencing (default false: use real high/low, warn).
  requireFullBuckets: false,
};

function pipSize(pair) { return /JPY$/.test(pair) ? 0.01 : 0.0001; }

module.exports = {
  HOUR_MS, DAY_MS, H1_MS, H4_MS, WEEK_MS, PAIRS, CONFIG, pipSize,
};
