'use strict';

/**
 * Trade-signal engine — configuration (versioned research defaults).
 *
 * ONE configurable engine, THREE independently-tracked strategies. Each strategy:
 *   period comparison → top-3 pairs → confirm direction → entry trigger → publish
 *   → execute (modelled) → track outcome → performance.
 *
 * All thresholds are CONFIGURABLE RESEARCH DEFAULTS, not proven-profitable settings.
 * Changing any param must create a NEW version (never rewrite past signals).
 *
 * Data reality (from backtest_candles): OANDA MID OHLC only (no bid/ask/spread),
 * tick volume, timeframes M5/M15/H1. Higher TFs (H4/D1) are aggregated from H1.
 * => All execution is ESTIMATED under the cost model below; finest intrabar
 *    monitoring granularity is M5. Account base currency is USD (configurable).
 */

const { CURRENCIES, PAIRS, pairFor, legsFor } = require('../comparison/config');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const TF_MS = { M5: 5 * MIN, M15: 15 * MIN, M30: 30 * MIN, H1: HOUR, H4: 4 * HOUR, D1: DAY };

/** Stored base resolution a timeframe is aggregated from (M15 for intraday, else H1). */
function baseForTf(tf) { return (tf === 'M5' || tf === 'M15' || tf === 'M30') ? tf : 'H1'; }

// Shared research-default parameters. Frozen into each signal's version.
const DEFAULT_PARAMS = {
  topN: 3,                    // select top-3 pairs by |differential|
  breadthMin: 5,              // appreciate/depreciate vs >= 5 of 7 counterparts
  atrPeriod: 14,              // Wilder ATR period on the entry timeframe
  stopAtrMult: 0.10,          // initial stop buffer beyond the 3-candle extreme
  maxRangeAtrMult: 2.0,       // reject trigger if candle-t range exceeds this * ATR
  entryDevAtrMult: 0.25,      // max permitted entry deviation from reference (price = mult*ATR)
  targetR: 2.0,               // take-profit at this multiple of initial risk
  maxHoldCandles: 16,         // max holding period in entry-TF candles (entry candle = #1)
  spreadStopFrac: 0.10,       // cancel entry if spread exceeds this fraction of entry-to-stop
  unchangedPairLogret: 1e-5,  // |oriented log return| <= this counts as "unchanged" (not support)
  // Portfolio / simulation assumptions (used in later phases):
  riskPerTradePct: 0.5,       // planned risk per trade, % of current equity
  maxAggregateRiskPct: 2.0,   // max aggregate planned OPEN risk
  maxPerCurrencyRiskPct: 1.0, // max planned open risk across positions sharing a currency
  initialEquity: 100000,      // model-portfolio starting equity (account currency)
};

// Estimated-execution cost model (mid-price history → costs are modelled, not observed).
// spreadPips: typical half-to-full spread applied on entry/exit; swapPipsPerDay: carry.
const COST_MODEL = {
  label: 'Estimated execution',
  account: 'USD',
  defaultSpreadPips: 1.0,         // fallback typical spread if a pair is not listed
  commissionPerLotPerSide: 3.5,   // USD per standard lot (100k) per side
  slippagePips: 0.3,              // modelled slippage added adversely on fills
  swapPipsPerDayLong: -0.3,       // financing applied to longs per calendar day held
  swapPipsPerDayShort: -0.3,      // financing applied to shorts per calendar day held
  // Per-pair typical spreads (pips). Research defaults; override per version.
  spreadPips: {
    EUR_USD: 0.6, GBP_USD: 0.9, AUD_USD: 0.8, NZD_USD: 1.2, USD_JPY: 0.7, USD_CHF: 1.0, USD_CAD: 1.0,
    EUR_GBP: 1.0, EUR_JPY: 1.2, EUR_CHF: 1.3, EUR_CAD: 1.6, EUR_AUD: 1.6, EUR_NZD: 2.5,
    GBP_JPY: 1.6, GBP_CHF: 2.0, GBP_CAD: 2.4, GBP_AUD: 2.4, GBP_NZD: 3.5,
    AUD_JPY: 1.2, AUD_CHF: 1.6, AUD_CAD: 1.6, AUD_NZD: 2.2,
    NZD_JPY: 1.6, NZD_CHF: 2.2, NZD_CAD: 2.2,
    CAD_JPY: 1.6, CAD_CHF: 2.0, CHF_JPY: 2.0,
  },
};

// The three strategies. select = period baseline; confirmTf/entryTf per spec §1.
const STRATEGIES = {
  today: { key: 'today', label: 'Today So Far', select: 'day',   confirmTf: 'H1', entryTf: 'M15', version: 'tsf-1.0.0' },
  week:  { key: 'week',  label: 'Week So Far',  select: 'week',  confirmTf: 'H4', entryTf: 'H1',  version: 'wsf-1.0.0' },
  month: { key: 'month', label: 'Month So Far', select: 'month', confirmTf: 'D1', entryTf: 'H4',  version: 'msf-1.0.0' },
};
const STRATEGY_KEYS = ['today', 'week', 'month'];

/** Full resolved strategy definition incl. params + cost model (deep-frozen copies). */
function strategyDef(key, paramOverrides) {
  const s = STRATEGIES[key];
  if (!s) throw new Error('unknown strategy: ' + key);
  const params = Object.assign({}, DEFAULT_PARAMS, paramOverrides || {});
  return {
    key: s.key, label: s.label, version: s.version,
    select: s.select, confirmTf: s.confirmTf, entryTf: s.entryTf,
    entryBaseTf: baseForTf(s.entryTf), confirmBaseTf: baseForTf(s.confirmTf),
    entryMs: TF_MS[s.entryTf], confirmMs: TF_MS[s.confirmTf],
    params, costs: COST_MODEL,
  };
}

/** Pip size for a pair (JPY quote => 0.01, else 0.0001). */
function pipSize(pair) { return /_JPY$/.test(pair) || /JPY$/.test(pair) ? 0.01 : 0.0001; }

module.exports = {
  CURRENCIES, PAIRS, pairFor, legsFor,
  TF_MS, MIN, HOUR, DAY, baseForTf,
  DEFAULT_PARAMS, COST_MODEL, STRATEGIES, STRATEGY_KEYS, strategyDef, pipSize,
};
