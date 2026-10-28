'use strict';

/**
 * Currency Movement Dashboard — configuration (research defaults, versioned).
 *
 * A NEW, ISOLATED module. It does NOT modify the existing currency-strength engines
 * (strengthnet.js, currency-strength-*-ema). It measures per-currency MOVEMENT from
 * completed M15 candles of the 28 majors, as decision support — NOT a trade signal,
 * probability, or evidence of profitability.
 *
 * Methodology (see engine.js): per pair, log return over the window; each currency
 * takes +return when it is the base and −return when it is the quote; each pair
 * return is normalized by the rolling std of NON-OVERLAPPING same-horizon returns
 * ending BEFORE the measured window (no look-ahead); the 7 signed normalized
 * contributions are aggregated with EQUAL weights → the "normalized movement score".
 */

const MOVEMENT_VERSION = 'cme-movement-1.0.0';
const M15_MS = 15 * 60 * 1000;

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const PAIRS = [
  'AUD_CAD', 'AUD_CHF', 'AUD_JPY', 'AUD_NZD', 'AUD_USD', 'CAD_CHF', 'CAD_JPY', 'CHF_JPY',
  'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'EUR_USD', 'GBP_AUD',
  'GBP_CAD', 'GBP_CHF', 'GBP_JPY', 'GBP_NZD', 'GBP_USD', 'NZD_CAD', 'NZD_CHF', 'NZD_JPY',
  'NZD_USD', 'USD_CAD', 'USD_CHF', 'USD_JPY',
];

/** For a currency, the 7 pairs containing it, with its role and the counterpart. */
function pairsForCurrency(ccy) {
  const out = [];
  for (const p of PAIRS) {
    const [base, quote] = p.split('_');
    if (base === ccy) out.push({ pair: p, role: 'base', other: quote });
    else if (quote === ccy) out.push({ pair: p, role: 'quote', other: base });
  }
  return out;
}

// Analysis windows, measured on completed M15 candles.
//  • intraday (1h/4h/12h/24h) = ELAPSED clock time: start = last completed M15 close
//    ≤ asOf − windowMs (weekends → fewer candles; endpoints are real closes, never filled).
//  • 5d = TRADING time: 480 completed M15 candles back (skips weekend gaps).
const WINDOWS = [
  { name: '1h', label: '1 hour', ms: 1 * 60 * 60 * 1000, candles: 4, kind: 'elapsed' },
  { name: '4h', label: '4 hours', ms: 4 * 60 * 60 * 1000, candles: 16, kind: 'elapsed' },
  { name: '12h', label: '12 hours', ms: 12 * 60 * 60 * 1000, candles: 48, kind: 'elapsed' },
  { name: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000, candles: 96, kind: 'elapsed' },
  { name: '5d', label: '5 trading days', ms: 5 * 24 * 60 * 60 * 1000, candles: 480, kind: 'trading' },
];
const windowByName = (n) => WINDOWS.find((w) => w.name === n) || WINDOWS[3];

const CONFIG = {
  version: MOVEMENT_VERSION,
  baseTimeframe: 'M15',
  // Rolling normalization (transparent std baseline).
  norm: { maxSamples: 60, minSamples: 20 },
  // Direction neutral band on the normalized movement score (research default).
  neutralBand: 0.5,
  // Breadth neutral band on each signed normalized pair contribution.
  breadthNeutral: 0.5,
  // Persistence: recent observations to look back over (completed M15 closes).
  persistence: { recentObs: 12 },
  // Causal onset rule: a qualifying observation needs |score| ≥ scoreMin, breadth support
  // ≥ breadthMin of coverage, and the direction held for ≥ persistMin consecutive obs.
  onset: { scoreMin: 0.75, breadthMin: 4, persistMin: 3 },
  // Extension labels on the magnitude percentile (0..1).
  extension: { elevated: 0.8, extreme: 0.95 },
};

module.exports = { MOVEMENT_VERSION, M15_MS, CURRENCIES, PAIRS, pairsForCurrency, WINDOWS, windowByName, CONFIG };
