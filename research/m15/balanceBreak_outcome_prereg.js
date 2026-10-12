'use strict';

/**
 * FROZEN pre-registration for the accepted-balance-break OUTCOME STUDY.
 *
 * This is SEPARATE from the detector and from any trading-profitability claim. It is
 * registered BEFORE evaluation and is evaluated only on LATER, UNSEEN periods
 * (walk-forward); the detector and its thresholds are frozen. No predictive probability
 * is reported until the study has actually been run on unseen data AND calibrated, and
 * no economic conclusion is stated while bid/ask costs are unavailable (mid-only data).
 */

const crypto = require('crypto');
const M15 = 15 * 60 * 1000;

const SPEC = Object.freeze({
  id: 'accepted-balance-break-outcome-study',
  specVersion: '1.1.0',   // 1.1.0: tightened group/horizon definitions before any evaluation (no results yet)
  registeredUtc: '2026-10-12T00:00:00.000Z',
  detectorVersion: 'accepted-balance-break-1.0.0',
  classifierVersion: 'm15-classifier-1.0.0',
  unit: 'one CONFIRMED accepted-balance-break instance, deduped by patternId; the clock starts at its confirmation close (knowableAtMs)',
  horizonsCandles: [4, 16],                     // completed M15 candles forward (4 = 1h, 16 = 4h), skipping no gaps: index +h in the eligible contiguous series
  outcomeMetric: 'continuation(h) = ( sign(close[T+h] - close[T]) === breakDirection ), on MID closes only; UNRESOLVED until candle T+h exists',
  excursionMetrics: ['maxFavorableExcursion', 'maxAdverseExcursion — both in units of the zone tol at confirmation'],
  comparisonGroups: [
    'pattern — CONFIRMED accepted-balance-break instances (one per patternId), direction = break direction',
    'classifier — every close whose simplified state is "Established trend" (engine ACCEPTED_TREND / ACCELERATING_TREND / EXHAUSTION_RISK), direction = that state\'s direction',
    'baseline — unconditional: EVERY completed close, direction = the break/state direction being tested (both signs reported), as the reference continuation rate',
  ],
  evaluationProtocol: 'walk-forward on LATER, UNSEEN periods only. Nothing is fit or chosen on the test window; detector + classifier + thresholds are frozen. Group instances by ISO week; report per-week and pooled to bound serial dependence.',
  reporting: Object.freeze({
    beforeCalibration: 'report ONLY counts, raw continuation fractions with an interval width, and excursions. Do NOT report a predictive probability or any edge claim.',
    predictiveProbability: 'UNAVAILABLE until evaluated on unseen data AND calibrated (reliability check).',
    economics: 'UNAVAILABLE — mid-only candles, no bid/ask. No cost-adjusted or profitability conclusion may be stated.',
  }),
  nullAndMultiplicity: 'Null = the unconditional baseline rate at the same horizon. 2 horizons x 3 groups; report all and correct for multiplicity before any claim.',
});

const SPEC_HASH = crypto.createHash('sha256').update(JSON.stringify(SPEC)).digest('hex');

// ── deterministic measurement helpers (no probabilities, no economics) ──────────
function _elig(candles) { return (candles || []).filter((c) => c && c.complete !== false).sort((a, b) => a.openMs - b.openMs); }

/** Resolved continuation for one instance at horizon h, or {resolved:false} if not enough forward candles. */
function continuationAt(candles, confirmMs, direction, h) {
  const e = _elig(candles);
  let i = -1; for (let k = 0; k < e.length; k++) if (e[k].openMs + M15 === confirmMs) { i = k; break; }
  if (i < 0 || i + h >= e.length) return { resolved: false };
  const base = e[i].close, fut = e[i + h].close, sgn = direction === 'UP' ? 1 : -1;
  return { resolved: true, continued: (fut - base) * sgn > 0, netMove: +(fut - base).toFixed(8) };
}

/** Max favourable / adverse excursion over the horizon, in units of tol (if given). */
function excursionAt(candles, confirmMs, direction, h, tol) {
  const e = _elig(candles);
  let i = -1; for (let k = 0; k < e.length; k++) if (e[k].openMs + M15 === confirmMs) { i = k; break; }
  if (i < 0 || i + h >= e.length) return { resolved: false };
  const base = e[i].close, sgn = direction === 'UP' ? 1 : -1; let fav = 0, adv = 0;
  for (let k = i + 1; k <= i + h; k++) { const m = (e[k].close - base) * sgn; if (m > fav) fav = m; if (m < adv) adv = m; }
  const u = tol && tol > 0 ? tol : 1;
  return { resolved: true, maxFavorable: +(fav / u).toFixed(4), maxAdverse: +(adv / u).toFixed(4), unit: tol ? 'tol' : 'price' };
}

/** Raw counts for a group at a horizon — NOT a probability. */
function scoreGroup(instances, candlesByPair, h) {
  let n = 0, resolved = 0, continued = 0;
  for (const ins of instances) {
    n++;
    const r = continuationAt(candlesByPair[ins.pair] || [], ins.confirmMs, ins.direction, h);
    if (!r.resolved) continue; resolved++; if (r.continued) continued++;
  }
  return { n, resolved, pending: n - resolved, continued, continuationFraction: resolved ? +(continued / resolved).toFixed(4) : null, note: 'raw fraction on resolved instances — NOT a calibrated probability' };
}

/** Assemble the study report. Enforces: no predictive probability, economics unavailable. */
function report(groupsByName, horizon) {
  return {
    spec: SPEC.id, specVersion: SPEC.specVersion, specHash: SPEC_HASH, horizon,
    groups: groupsByName,
    predictiveProbability: 'UNAVAILABLE (not yet evaluated on unseen data and calibrated)',
    economics: 'UNAVAILABLE (mid-only; no bid/ask)',
    status: 'PENDING — definition frozen; results accrue on later unseen periods.',
  };
}

module.exports = { SPEC, SPEC_HASH, M15, continuationAt, excursionAt, scoreGroup, report };
