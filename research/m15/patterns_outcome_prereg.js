'use strict';

/**
 * FROZEN integrated pre-registration for the THREE M15 structure patterns:
 *   accepted-balance-break, failed-balance-break, trend-pullback-continuation.
 *
 * Registered before examining outcomes. Evaluated only with chronological out-of-sample
 * splits and an EMBARGO gap ≥ the longest horizon, so no forecast window leaks across the
 * split. No predictive probability is reported until produced AND calibrated on unseen data;
 * trading economics are assessed only with realistic spread/execution data (otherwise
 * UNAVAILABLE). If results are weak or inconsistent, the system displays "no reliable
 * forecast" rather than forcing a prediction. No orders / buy-sell / profitability claims.
 */

const crypto = require('crypto');
const base = require('./balanceBreak_outcome_prereg');   // reuse continuationAt / excursionAt
const M15 = 15 * 60 * 1000;

const SPEC = Object.freeze({
  id: 'm15-structure-patterns-integrated-outcome-study',
  specVersion: '1.0.0',
  registeredUtc: '2026-10-12T00:00:00.000Z',
  detectors: Object.freeze({
    acceptedBreak: 'accepted-balance-break-1.0.0',
    failedBreak: 'failed-balance-break-1.0.0',
    pullback: 'trend-pullback-continuation-1.0.0',
  }),
  classifierVersion: 'm15-classifier-1.0.0',
  horizonsCandles: [4, 16],                  // 1h and 4h
  outcomeMetric: 'continuation(h) = ( sign(close[T+h] - close[T]) === patternDirection ), MID closes; UNRESOLVED until T+h exists',
  excursionMetrics: ['maxFavorableExcursion', 'maxAdverseExcursion in units of the scale at confirmation'],
  comparisonBaselines: [
    'classifier — the existing classifier Established-trend closes',
    'unconditional — every completed close (reference rate)',
    'cross-pattern — each pattern vs the other two (e.g. does the failed break add beyond the accepted-break transition?)',
  ],
  deduplication: Object.freeze({
    perEpisode: 'one instance per patternId (the confirmation close); CONTINUATION/hold events are not separate instances',
    nonOverlappingSubsample: 'for the headline estimate, keep at most ONE instance per pair per horizon-length window (no overlapping forecast windows within a pair)',
  }),
  evaluationProtocol: 'chronological (time-ordered) out-of-sample: split by date; TRAIN strictly before TEST; nothing fit/selected on TEST; detectors+classifier+thresholds frozen.',
  embargoCandles: 16,                        // ≥ max horizon: drop instances within 16 candles of the split boundary
  metrics: ['sampleSize (n, resolved, pending)', 'directional continuation fraction', 'Wilson 95% interval (uncertainty)', 'forecast calibration (ONLY if probabilities are produced)', 'pair breakdown', 'session breakdown (Asian/London/NY by EAT)', 'delta vs classifier and vs unconditional baseline'],
  reporting: Object.freeze({
    predictiveProbability: 'UNAVAILABLE until produced and calibrated on unseen data',
    economics: 'UNAVAILABLE unless realistic spread + execution data are supplied',
    weakResultPolicy: 'if sample is small, intervals overlap the baseline, or results are inconsistent across pairs/sessions ⇒ display "no reliable forecast" (do not force a prediction)',
  }),
});

const SPEC_HASH = crypto.createHash('sha256').update(JSON.stringify(SPEC)).digest('hex');

// ── deterministic helpers (no probabilities, no economics) ──────────────────────
function wilson95(k, n) {
  if (!n) return { lo: null, hi: null, width: null };
  const z = 1.959964, p = k / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { lo: +(centre - half).toFixed(4), hi: +(centre + half).toFixed(4), width: +(2 * half).toFixed(4) };
}
function sessionOfEat(ms) { const h = new Date(ms + 3 * 60 * 60 * 1000).getUTCHours(); if (h >= 10 && h < 18) return 'LONDON'; if (h >= 15 && h < 24) return 'NEWYORK'; return 'ASIAN'; }

/** Dedup to ≤1 instance per pair per horizon-length window (non-overlapping subsample). */
function nonOverlapping(instances, horizon) {
  const byPair = {}; const kept = [];
  for (const ins of instances.slice().sort((a, b) => a.confirmMs - b.confirmMs)) {
    const lastMs = byPair[ins.pair];
    if (lastMs == null || ins.confirmMs - lastMs >= horizon * M15) { kept.push(ins); byPair[ins.pair] = ins.confirmMs; }
  }
  return kept;
}

/** Score one group at a horizon — raw counts + uncertainty + breakdowns. NO probability. */
function scoreGroup(instances, candlesByPair, horizon) {
  const resolved = []; let pending = 0;
  for (const ins of instances) { const r = base.continuationAt(candlesByPair[ins.pair] || [], ins.confirmMs, ins.direction, horizon); if (!r.resolved) { pending++; continue; } resolved.push({ ins, continued: r.continued }); }
  const n = resolved.length, k = resolved.filter((x) => x.continued).length;
  const byPair = {}, bySession = {};
  for (const x of resolved) { (byPair[x.ins.pair] = byPair[x.ins.pair] || [0, 0]), byPair[x.ins.pair][0]++, (x.continued && byPair[x.ins.pair][1]++); const s = sessionOfEat(x.ins.confirmMs); (bySession[s] = bySession[s] || [0, 0]), bySession[s][0]++, (x.continued && bySession[s][1]++); }
  const frac = (arr) => arr[0] ? +(arr[1] / arr[0]).toFixed(4) : null;
  return {
    count: instances.length, resolved: n, pending,
    continuationFraction: n ? +(k / n).toFixed(4) : null, uncertainty: wilson95(k, n),
    byPair: Object.fromEntries(Object.entries(byPair).map(([p, a]) => [p, { n: a[0], frac: frac(a) }])),
    bySession: Object.fromEntries(Object.entries(bySession).map(([s, a]) => [s, { n: a[0], frac: frac(a) }])),
    note: 'raw directional continuation on resolved instances — NOT a calibrated probability',
  };
}

/**
 * Decide whether ANY pattern has earned a forecasting display. Conservative by design:
 * requires a real OOS evaluation with adequate sample and an interval that clears the
 * baseline. With no such evaluation, returns NO_RELIABLE_FORECAST.
 */
function decideDisplay(evaluation) {
  if (!evaluation || !evaluation.ran) return { enabled: false, verdict: 'NO_RELIABLE_FORECAST', why: 'no chronological out-of-sample, calibrated evaluation has been run' };
  // (left intentionally strict; a real decision also needs calibration + cross-pattern + economics)
  return { enabled: false, verdict: 'NO_RELIABLE_FORECAST', why: 'pending calibration, cross-pattern and economic checks' };
}

function report(groupsByName, horizon) {
  return {
    spec: SPEC.id, specVersion: SPEC.specVersion, specHash: SPEC_HASH, horizon, groups: groupsByName,
    predictiveProbability: 'UNAVAILABLE (not produced/calibrated on unseen data)',
    economics: 'UNAVAILABLE (no realistic spread/execution data)',
    decision: decideDisplay(null),
    status: 'PENDING — definitions frozen; results accrue on later unseen periods.',
  };
}

module.exports = { SPEC, SPEC_HASH, M15, wilson95, sessionOfEat, nonOverlapping, scoreGroup, decideDisplay, report, continuationAt: base.continuationAt };
