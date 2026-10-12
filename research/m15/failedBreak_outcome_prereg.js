'use strict';

/**
 * FROZEN pre-registration for the FAILED-balance-break OUTCOME STUDY.
 *
 * Distinct from the accepted-break study. Registered before evaluation; evaluated only on
 * LATER, UNSEEN periods with time-ordered (walk-forward) splitting. A failed break is NOT a
 * reversal claim — the study only measures how much, if at all, the label carries information
 * about the next few candles, and whether it IMPROVES forecasts over (a) the existing
 * classifier, (b) the accepted-break transition alone, and (c) an unconditional baseline.
 * No predictive probability is reported until evaluated and calibrated; profitability stays
 * UNAVAILABLE without defensible transaction-cost (bid/ask) data. No entry/exit instructions.
 */

const crypto = require('crypto');
const base = require('./balanceBreak_outcome_prereg');   // reuse continuationAt / excursionAt / scoreGroup helpers

const SPEC = Object.freeze({
  id: 'failed-balance-break-outcome-study',
  specVersion: '1.0.0',
  registeredUtc: '2026-10-12T00:00:00.000Z',
  detectorVersion: 'failed-balance-break-1.0.0',
  builtOn: 'accepted-balance-break-1.0.0',
  classifierVersion: 'm15-classifier-1.0.0',
  unit: 'one CONFIRMED failed-balance-break instance, deduped by patternId; the clock starts at the reclaim (confirmation) close — never the departure candle',
  horizonsCandles: [4, 16],                     // completed M15 candles forward (4 = 1h, 16 = 4h)
  // Measured DESCRIPTIVELY in the ORIGINAL attempt direction — a failed break is not asserted to reverse.
  outcomeMetric: 'continuation(h) = ( sign(close[T+h] - close[T]) === attemptDirection ); both signs reported; UNRESOLVED until candle T+h exists',
  excursionMetrics: ['maxFavorableExcursion', 'maxAdverseExcursion in the attempt direction — units of the zone tol at confirmation'],
  comparisonGroups: [
    'failed — CONFIRMED failed-break instances (direction = the ORIGINAL attempt direction)',
    'classifier — the existing classifier Established-trend closes (as a forecaster)',
    'accepted-transition — CONFIRMED accepted-break instances alone (does knowing the FAILURE add information beyond knowing a break was accepted?)',
    'baseline — unconditional: every completed close (reference continuation rate)',
  ],
  evaluationProtocol: 'time-ordered walk-forward on LATER, UNSEEN periods only; detector/classifier/thresholds frozen.',
  overlapHandling: 'forward windows overlap, so instances are NOT independent. Block by ISO week; additionally report a NON-OVERLAPPING subsample (at most one instance per pair per horizon-length window) and treat pooled intervals as indicative only.',
  reporting: Object.freeze({
    beforeCalibration: 'report ONLY counts, raw continuation fractions with an interval width (noting overlap), and excursions. No predictive probability, no edge claim, no reversal claim.',
    predictiveProbability: 'UNAVAILABLE until evaluated on unseen data AND calibrated.',
    economics: 'UNAVAILABLE — mid-only; no bid/ask. No profitability or cost-adjusted conclusion.',
    improvementTest: 'report failed vs each comparison group at each horizon; an "improvement" may be claimed only after calibrated, overlap-aware evaluation on unseen data.',
  }),
});

const SPEC_HASH = crypto.createHash('sha256').update(JSON.stringify(SPEC)).digest('hex');

function report(groupsByName, horizon) {
  return {
    spec: SPEC.id, specVersion: SPEC.specVersion, specHash: SPEC_HASH, horizon,
    groups: groupsByName,
    predictiveProbability: 'UNAVAILABLE (not yet evaluated on unseen data and calibrated)',
    economics: 'UNAVAILABLE (mid-only; no bid/ask)',
    improvement: 'UNAVAILABLE until overlap-aware, calibrated evaluation on unseen data',
    status: 'PENDING — definition frozen; results accrue on later unseen periods.',
  };
}

module.exports = { SPEC, SPEC_HASH, continuationAt: base.continuationAt, excursionAt: base.excursionAt, scoreGroup: base.scoreGroup, report };
