'use strict';

/**
 * Currency Candle Comparison — configuration (versioned research defaults).
 *
 * Constructs RELATIVE currency index candles for the 8 majors from synchronized M15
 * pair log-returns. Research / pair-selection tool — NO automated execution, buy/sell
 * signals, profitability claims, or opaque combined strength score.
 *
 * Currency index (zero-sum, 8-currency): for currency c,
 *   r_c(t) = (1/8) · Σ_{j≠c} s(c,j)·ln( P_pair(c,j)(t) / P_pair(c,j)(t−1) )
 * where s(c,j)=+1 if the provider quotes c as base (c_j), −1 if c is the quote (j_c).
 * Indices accumulate from a common base value (100). The 1/8 normalization is the
 * eight-currency zero-sum construction (NOT 1/7).
 *
 * Trading day = UTC calendar day (00:00→00:00 UTC) — the documented, DST-free
 * convention already used by the app's D1 aggregation. Sessions use named,
 * DST-aware timezones. All timestamps stored/compared in UTC; display tz configurable.
 */

const COMPARISON_VERSION = 'ccc-1.0.0';
const M15_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_VALUE = 100;

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const PAIRS = [
  'AUD_CAD', 'AUD_CHF', 'AUD_JPY', 'AUD_NZD', 'AUD_USD', 'CAD_CHF', 'CAD_JPY', 'CHF_JPY',
  'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'EUR_USD', 'GBP_AUD',
  'GBP_CAD', 'GBP_CHF', 'GBP_JPY', 'GBP_NZD', 'GBP_USD', 'NZD_CAD', 'NZD_CHF', 'NZD_JPY',
  'NZD_USD', 'USD_CAD', 'USD_CHF', 'USD_JPY',
];

/** The provider pair for currencies (c,j) and the sign that orients it to c's return. */
function pairFor(c, j) {
  if (PAIRS.indexOf(c + '_' + j) >= 0) return { pair: c + '_' + j, sign: 1 };
  if (PAIRS.indexOf(j + '_' + c) >= 0) return { pair: j + '_' + c, sign: -1 };
  return null;
}
/** The 7 counterpart legs for a currency: {counterpart, pair, sign}. */
function legsFor(c) {
  const out = [];
  for (const j of CURRENCIES) { if (j === c) continue; const pf = pairFor(c, j); if (pf) out.push({ counterpart: j, pair: pf.pair, sign: pf.sign }); }
  return out;
}

// Session windows in NAMED, DST-aware timezones (local clock hours). Documented defaults.
const SESSIONS = [
  { name: 'asia', label: 'Asia (Tokyo)', tz: 'Asia/Tokyo', startHour: 9, endHour: 18 },
  { name: 'london', label: 'London', tz: 'Europe/London', startHour: 8, endHour: 17 },
  { name: 'newyork', label: 'New York', tz: 'America/New_York', startHour: 8, endHour: 17 },
];
const sessionByName = (n) => SESSIONS.find((s) => s.name === n) || SESSIONS[1];

const CONFIG = {
  version: COMPARISON_VERSION,
  baseTimeframe: 'M15',
  baseValue: BASE_VALUE,
  // "unchanged" tolerance on a currency's open→close % return (research default).
  unchangedPct: 0.01,
  // "unchanged" tolerance on a pair's log return for breadth classification.
  unchangedPairLogret: 1e-5,
  tradingDay: { kind: 'utc', note: 'UTC calendar day 00:00→00:00 (DST-free; matches existing D1 aggregation).' },
  historyStartHintIso: '2025-05-01T00:00:00Z',   // actual available start is read from the data
};

module.exports = { COMPARISON_VERSION, M15_MS, DAY_MS, BASE_VALUE, CURRENCIES, PAIRS, pairFor, legsFor, SESSIONS, sessionByName, CONFIG };
