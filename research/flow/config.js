'use strict';

/**
 * NervaFX Inverted Flow Chart — configuration (research).
 *
 * A custom Renko-style chart where a block's HEIGHT is a fixed price step and its WIDTH is the
 * number of eligible observations received (feed activity), with a thin trace of the observed path
 * inside each block. 36 selectable instruments: the 28 FX pairs + the 8 zero-sum currency indices.
 *
 * Reuses the Currency Comparison instrument set and the zero-sum 1/8 index (research/comparison).
 * No automated execution, buy/sell signal, probability, or profitability claim. Width is FEED
 * ACTIVITY (received quote updates or completed closes) — NOT traded lots, money, or buyer/seller
 * identity.
 */

const { PAIRS, CURRENCIES, M5_MS, M15_MS, H1_MS } = require('../comparison/config');

const FLOW_VERSION = 'nfx-flow-1.0.0';

// Pip size + display precision per instrument.
//  - JPY-quoted pairs (incl. CHF/JPY): pip = 0.01, 3-dp display (fractional pip = 3rd dp).
//  - all other pairs:                  pip = 0.0001, 5-dp display (fractional pip = 5th dp).
const JPY_PAIRS = new Set(['EUR_JPY', 'GBP_JPY', 'AUD_JPY', 'NZD_JPY', 'CAD_JPY', 'CHF_JPY', 'USD_JPY']);

function pairPip(pair) { return JPY_PAIRS.has(pair) ? 0.01 : 0.0001; }
function pairPrecision(pair) { return JPY_PAIRS.has(pair) ? 3 : 5; }

// Default STEP preset: 5 pips for every pair (reproduces the EUR/USD reference example). This is a
// DISPLAY preset only — its trading performance has not been established.
const DEFAULT_PAIR_PIPS = 5;

// Currency-index step is expressed in PERCENTAGE POINTS from the daily baseline. Default 0.05 pp.
// If returns are stored as decimals, 0.05 pp corresponds to 0.0005 internally; this chart runs the
// block engine on the index's signed % path (pp), so the step is literally 0.05 (pp).
const DEFAULT_INDEX_STEP_PP = 0.05;

const RES_MS = { M5: M5_MS, M15: M15_MS, H1: H1_MS };
const PAIR_RESOLUTIONS = ['M5', 'M15', 'H1'];
const DEFAULT_PAIR_RESOLUTION = 'M5';   // finest stored → most activity detail

/** Round a price to the instrument's display precision (kills float drift at thresholds). */
function roundPrice(value, precision) { const f = Math.pow(10, precision); return Math.round(value * f) / f; }

/** Instrument descriptor for a pair, e.g. 'EUR_USD'. */
function pairInstrument(pair) {
  const pip = pairPip(pair);
  const precision = pairPrecision(pair);
  return {
    id: pair, kind: 'pair', label: pair.replace('_', '/'), pip, precision,
    stepPips: DEFAULT_PAIR_PIPS, step: roundPrice(DEFAULT_PAIR_PIPS * pip, precision),
    unit: 'received closes', valueLabel: 'midpoint price',
  };
}

/** Instrument descriptor for a currency index, e.g. 'IDX:EUR'. Value axis = % points from baseline. */
function indexInstrument(ccy) {
  return {
    id: 'IDX:' + ccy, kind: 'index', currency: ccy, label: ccy + ' index', pip: null,
    precision: 3, stepPips: null, step: DEFAULT_INDEX_STEP_PP,
    unit: 'constituent basket snapshots', valueLabel: '% from baseline (pp)',
  };
}

/** All 36 instrument descriptors (28 pairs, then 8 indices). */
function allInstruments() {
  return PAIRS.map(pairInstrument).concat(CURRENCIES.map(indexInstrument));
}

/** Resolve an instrument id ('EUR_USD' or 'IDX:EUR') to its descriptor, or null. */
function instrumentFor(id) {
  if (!id) return null;
  if (id.indexOf('IDX:') === 0) { const c = id.slice(4); return CURRENCIES.indexOf(c) >= 0 ? indexInstrument(c) : null; }
  return PAIRS.indexOf(id) >= 0 ? pairInstrument(id) : null;
}

module.exports = {
  FLOW_VERSION, PAIRS, CURRENCIES, JPY_PAIRS,
  RES_MS, PAIR_RESOLUTIONS, DEFAULT_PAIR_RESOLUTION, DEFAULT_PAIR_PIPS, DEFAULT_INDEX_STEP_PP,
  pairPip, pairPrecision, roundPrice, pairInstrument, indexInstrument, allInstruments, instrumentFor,
};
