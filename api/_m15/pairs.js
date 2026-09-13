'use strict';

/**
 * M15 Intelligence — currency & pair constants (single source of truth).
 *
 * Eight currencies and the standard 28 pairs. Also exposes pip size and a
 * per-instrument minimum price threshold used by the adaptive engines as a
 * hard noise floor (§10). No timeframe other than M15 is ever referenced.
 */

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

const PAIRS = [
  'AUD_CAD', 'AUD_CHF', 'AUD_JPY', 'AUD_NZD', 'AUD_USD',
  'CAD_CHF', 'CAD_JPY', 'CHF_JPY',
  'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'EUR_USD',
  'GBP_AUD', 'GBP_CAD', 'GBP_CHF', 'GBP_JPY', 'GBP_NZD', 'GBP_USD',
  'NZD_CAD', 'NZD_CHF', 'NZD_JPY', 'NZD_USD',
  'USD_CAD', 'USD_CHF', 'USD_JPY',
];

/** Base / quote split for a pair like "EUR_USD" → { base:'EUR', quote:'USD' }. */
function split(pair) {
  const [base, quote] = pair.split('_');
  return { base, quote };
}

/** JPY-quoted pairs quote in 0.01 pips; everything else 0.0001. */
function pipSize(pair) {
  return pair.endsWith('_JPY') ? 0.01 : 0.0001;
}

/** Price decimal precision (5 for most, 3 for JPY) — OANDA convention. */
function precision(pair) {
  return pair.endsWith('_JPY') ? 3 : 5;
}

/**
 * Instrument minimum threshold in PRICE units — the smallest directional move
 * the structural engine will ever treat as real, regardless of low volatility.
 * Two pips: a conservative hard floor so a dead market cannot manufacture legs.
 */
function instrumentMinThreshold(pair) {
  return pipSize(pair) * 2;
}

/** All 28 pairs that contain a given currency, with its role in each. */
function pairsForCurrency(ccy) {
  return PAIRS.filter((p) => p.startsWith(ccy + '_') || p.endsWith('_' + ccy)).map((pair) => ({
    pair,
    role: pair.startsWith(ccy + '_') ? 'BASE' : 'QUOTE',
  }));
}

module.exports = {
  CURRENCIES, PAIRS, split, pipSize, precision, instrumentMinThreshold, pairsForCurrency,
};
