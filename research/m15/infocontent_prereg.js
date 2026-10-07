'use strict';

/**
 * Stage E — FROZEN pre-registration for the classifier-state information-content study.
 *
 * This file is written and hashed BEFORE any outcome table is computed or viewed. It
 * fixes the hypotheses, eligible pairs, episode/dedup rules, entry/measurement, horizons,
 * risk units, folds, embargo, cost/delay scenarios, matched controls, and the
 * reject/insufficient/eligible gates. No boundary may be changed after outer results are
 * seen. A gate pass NEVER proves live profitability — it only permits owner review for a
 * future prospective shadow cohort, and it does NOT overturn the immutable Stage 5/5A
 * NONE PASSED decision.
 */

const crypto = require('crypto');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

const PREREGISTRATION = Object.freeze({
  version: 'm15-infocontent-1.0.0',
  registeredAtUtc: '2026-10-07T00:00:00.000Z',
  purpose: 'Test whether M15 classifier states carry useful FUTURE information. This does NOT create a strategy; a gate pass only permits owner review for a future prospective shadow cohort.',

  hypotheses: [
    { id: 'H1', statement: 'Accepted trends (ACCEPTED/ACCELERATING_TREND_*) have MORE same-direction net forward movement than matched opportunities (same pair, session, volatility bucket).', metric: 'mean same-direction forward R (dirSign·fwd/ATR) minus matched-control mean', direction: 'greater_than_0' },
    { id: 'H2', statement: 'Rejected departures are LESS likely to continue than accepted departures.', metric: 'continuation rate (same-direction move beyond entry at horizon) of DEPARTURE_ACCEPTED minus DEPARTURE_PROVISIONAL-then-returned (rejected)', direction: 'accepted_minus_rejected_greater_than_0' },
    { id: 'H3', statement: 'Independent currency breadth adds information beyond the price-only state.', metric: 'same-direction forward R of states WITH independent strength confirmation minus the SAME episodes classified price-only (strength omitted)', direction: 'greater_than_0' },
  ],

  config: {
    eligiblePairs: ['AUD_CAD','AUD_CHF','AUD_JPY','AUD_NZD','AUD_USD','CAD_CHF','CAD_JPY','CHF_JPY','EUR_AUD','EUR_CAD','EUR_CHF','EUR_GBP','EUR_JPY','EUR_NZD','EUR_USD','GBP_AUD','GBP_CAD','GBP_CHF','GBP_JPY','GBP_NZD','GBP_USD','NZD_CAD','NZD_CHF','NZD_JPY','NZD_USD','USD_CAD','USD_CHF','USD_JPY'],
    episode: {
      definition: 'An episode opens at the FIRST completed close at which a target state family is entered (transition into it) for a pair. Only one open episode per pair at a time; a new episode of the same family may open only after the pair leaves that family (cooldown).',
      dedupKey: ['pair', 'stateFamily', 'direction', 'firstCloseMs'],
      noOverlapPerPair: true,
    },
    entry: 'Next practicable price = the OPEN of the next completed candle after the signal close (never same-bar). Delay scenarios add whole candles.',
    measurement: 'Signed forward log-price move from entry, in ATR risk units (R).',
    horizonsCandles: [4, 8, 16],
    riskUnit: 'ATR14 (price units) at the signal close; outcome R = dirSign · (price[entry+H] − price[entry]) / ATR14.',
    folds: { scheme: 'chronological nested walk-forward', outerFolds: 5, order: 'train on prior blocks, evaluate on the next; expanding origin', innerCalibration: 'state boundaries calibrated on inner-train descriptor distributions ONLY; applied unchanged to the test block', postResultChanges: 'FORBIDDEN' },
    embargoCandles: 96,
    timestamps: 'Pair AND network timestamps are kept together at the same synchronized close; never combined across closes.',
    uncertainty: 'Dependence-aware week-block bootstrap (ISO-week blocks), seeded (seed=20261007), 2000 resamples, 95% CI.',
    multipleTesting: 'Holm-Bonferroni across the 3 primary hypotheses (familywise 0.05).',
    controls: {
      priceOnly: 'The SAME episodes re-classified with the currency network OMITTED (price-only state).',
      matchedNull: 'Random same-direction entries at matched (pair, session) times, seeded; same horizons/costs.',
      matchedOpportunity: 'For H1, non-accepted eligible closes in the same pair/session/volatility bucket.',
    },
    costs: {
      dataProvenanceRule: 'If actual bid/ask is available, use it and label CONFIRMED. Otherwise economics are mid-based and labelled ESTIMATED; tradability MUST NOT be asserted.',
      estimatedSpreadPips: { default: 1.0, JPY: 1.2, exotic: 1.8 },
      delayScenariosCandles: [0, 1],
    },
    gates: {
      insufficient: 'ANY of: < 200 independent episodes; < 8 ISO-week blocks; coverage partial/unsynchronized; data provenance SYNTHETIC or EXPLORATORY (previously examined history is EXPLORATORY).',
      reject: 'Holm-adjusted 95% CI of the effect lies entirely at or below 0.',
      eligible: 'ALL of: Holm-adjusted CI > 0; out-of-sample across ALL outer folds; effect beats BOTH the price-only and matched-null controls; positive in >= 60% of week-blocks; no single pair/currency > 50% of episodes or of the effect; >= 200 independent episodes; AND economics at most ESTIMATED. Verdict is then ELIGIBLE_FOR_NEW_SHADOW_REVIEW (owner review only) — NEVER proof of live profitability.',
    },
    preserve: 'Stage 5 / Stage 5A results and the NONE PASSED decision are immutable and are NOT overturned by this stage. A gate pass only opens owner review for a FUTURE prospective shadow cohort under a new version.',
    retention: 'Every attempted version, trial, and negative result is kept.',
  },

  verdictSpace: ['REJECT', 'INSUFFICIENT_EVIDENCE', 'ELIGIBLE_FOR_NEW_SHADOW_REVIEW'],
  nonNegotiable: 'Historical fit is NEVER labelled as proof of live profitability. No live signals, scheduler, broker, deployment, or push in this stage.',
});

const registrationHash = crypto.createHash('sha256').update(stableStringify(PREREGISTRATION)).digest('hex');

module.exports = { PREREGISTRATION, registrationHash, stableStringify };
