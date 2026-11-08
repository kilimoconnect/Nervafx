'use strict';

/**
 * Shared, strictly-causal strategy evaluator (spec §4, §9). The SAME function drives
 * historical backfill and live forward processing.
 *
 * Causality: the zero-sum index accumulates multiplicatively from the first observation,
 * and Wilder ATR depends only on past true ranges — both are functions of data at or
 * before each point. So a context built ONCE over the full history can be read at any
 * `asOfMs` with no look-ahead (idxAtOrBefore / pairCloseAtOrBefore / a binary-searched
 * entry-candle prefix all ignore anything after asOf). This keeps a full 18-month
 * backfill O(n log n) instead of rebuilding the index every candle.
 *
 * At each asOf (an entry-TF candle close) it:
 *   1. reconstructs the period comparison through asOf,
 *   2. recomputes the top-3 ranking,
 *   3. confirms using the latest FULLY COMPLETED confirmation candle,
 *   4. evaluates the completed entry candle t for the 3-candle trigger + ATR,
 *   5. returns a ranking snapshot, per-shortlist status, and any publishable signals.
 */

const { CURRENCIES, PAIRS, TF_MS } = require('./config');
const { buildIndices } = require('../comparison/index-build');
const { aggregatePairs } = require('../comparison/aggregate');
const { dayStart, weekStart, monthStart } = require('../comparison/periods');
const { wilderATR } = require('./atr');
const { currencyReturns, rankPairs, topN } = require('./selection');
const { evaluateCandidate } = require('./confirm');
const { buildPlan } = require('./trigger');

const STATUS = {
  INCOMPLETE: 'incomplete-data',
  NO_BIAS: 'no-directional-bias',
  WAIT_CONFIRM: 'waiting-for-confirmation',
  WAIT_TRIGGER: 'waiting-for-entry-trigger',
  PUBLISHED: 'signal-published',
};

function baselineMs(select, asOfMs) {
  if (select === 'day') return dayStart(asOfMs);
  if (select === 'week') return weekStart(asOfMs);
  if (select === 'month') return monthStart(asOfMs);
  throw new Error('unknown select period: ' + select);
}

/** Latest COMPLETED fixed-width candle interval (H1/H4/D1) as of asOfMs. */
function latestCompletedInterval(tfMs, asOfMs) {
  const end = Math.floor(asOfMs / tfMs) * tfMs;
  return { startMs: end - tfMs, endMs: end };
}

/** Keep only base candles whose CLOSE (openMs+baseMs) <= asOf (defensive causal cut). */
function causalCut(baseByPair, baseMs, asOfMs) {
  const out = {};
  for (const p of PAIRS) {
    const cs = baseByPair[p] || [];
    const kept = [];
    for (const c of cs) { if (c.openMs + baseMs <= asOfMs) kept.push(c); else break; }
    out[p] = kept;
  }
  return out;
}

function entryCandlesFor(baseCandles, entryTf, entryMs, asOfMs) {
  const agg = aggregatePairs(baseCandles, entryTf);
  const out = [];
  for (const c of agg) { if (c.time + entryMs <= asOfMs) out.push(c); else break; }
  return out;
}

/** Last index i where candle close (cands[i].time+entryMs) <= asOf, via binary search. */
function lastClosedIdx(cands, entryMs, asOfMs) {
  let lo = 0, hi = cands.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cands[m].time + entryMs <= asOfMs) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/**
 * Precompute everything that is causal-safe to share across all asOf evaluations:
 *   - global zero-sum index built at the entry base resolution,
 *   - aggregated entry candles per pair (+ their Wilder ATR array through each candle).
 * baseByPair: { pair: base candles at def.entryBaseTf } ascending.
 */
function buildContext(def, baseByPair) {
  const baseMs = TF_MS[def.entryBaseTf];
  const built = buildIndices(baseByPair, { baseMs });
  const entryByPair = {}, atrByPair = {};
  for (const p of PAIRS) {
    const agg = aggregatePairs(baseByPair[p] || [], def.entryTf);
    entryByPair[p] = agg;
    atrByPair[p] = wilderATR(agg, def.params.atrPeriod).atr;
  }
  return { def, baseMs, built, baseByPair, entryByPair, atrByPair };
}

/** Evaluate one strategy at asOfMs against a prebuilt context. */
function evaluateAt(def, asOfMs, ctx) {
  const built = ctx.built;
  if (!built.ok) return { ok: false, asOfMs, reason: built.reason || 'insufficient synchronized candles', ranking: [], shortlist: [], signals: [] };

  const base = baselineMs(def.select, asOfMs);
  const returns = currencyReturns(built, CURRENCIES, base, asOfMs);
  const ranking = rankPairs(returns, PAIRS);
  const shortlist = topN(ranking, def.params.topN);

  const confInt = latestCompletedInterval(def.confirmMs, asOfMs);
  const prevInt = { startMs: confInt.startMs - def.confirmMs, endMs: confInt.startMs };
  const signals = [], rows = [];

  for (const cand of shortlist) {
    const row = {
      rank: cand.rank, pair: cand.pair, a: cand.a, b: cand.b, bias: cand.bias,
      differential: cand.differential, status: STATUS.WAIT_CONFIRM, reasons: [],
    };
    if (cand.bias === 'none' || cand.differential == null) { row.status = cand.differential == null ? STATUS.INCOMPLETE : STATUS.NO_BIAS; rows.push(row); continue; }

    const conf = evaluateCandidate(cand, built, ctx.baseByPair, ctx.baseMs, confInt, def.params);
    const confPrev = evaluateCandidate(cand, built, ctx.baseByPair, ctx.baseMs, prevInt, def.params);
    row.confirmation = {
      interval: confInt, pass: conf.pass, reasons: conf.reasons,
      readings: conf.readings, breadth: conf.breadth,
      previous: { interval: prevInt, readings: confPrev.readings, breadth: confPrev.breadth },
    };
    if (!conf.pass) { row.status = STATUS.WAIT_CONFIRM; row.reasons = conf.reasons; rows.push(row); continue; }

    const ec = ctx.entryByPair[cand.pair] || [];
    const idxT = lastClosedIdx(ec, def.entryMs, asOfMs);
    if (idxT < Math.max(2, def.params.atrPeriod)) { row.status = STATUS.WAIT_TRIGGER; row.reasons = ['insufficient entry candles']; rows.push(row); continue; }
    const t = ec[idxT], t1 = ec[idxT - 1], t2 = ec[idxT - 2], atr = ctx.atrByPair[cand.pair][idxT];
    const trig = buildPlan(t2, t1, t, atr, cand.bias, def.params, def.entryMs);
    row.trigger = { pass: trig.pass, reasons: trig.reasons, atr: trig.atr };
    if (!trig.pass) { row.status = STATUS.WAIT_TRIGGER; row.reasons = trig.reasons; rows.push(row); continue; }

    row.status = STATUS.PUBLISHED;
    const plan = trig.plan;
    signals.push({
      strategyKey: def.key, version: def.version,
      pair: cand.pair, direction: cand.bias, rank: cand.rank,
      periodDifferential: cand.differential,
      infoCutoffMs: asOfMs, publishedAtMs: asOfMs,
      entryCloseMs: plan.entryCloseMs,
      confirmation: row.confirmation,
      trigger: plan.triggerCandles,
      atr: plan.atr,
      referenceEntry: plan.referenceEntry,
      referenceRisk: plan.referenceRisk,
      maxDeviation: plan.maxDeviation,
      fixedStop: plan.fixedStop,
      indicativeTarget: plan.indicativeTarget,
      entryExpiryMs: plan.entryCloseMs + def.entryMs,
      rangeAtrRatio: plan.rangeAtrRatio,
    });
    rows.push(row);
  }

  return { ok: true, asOfMs, baselineMs: base, resolution: built.resolution, ranking, shortlist: rows, signals, confirmInterval: confInt };
}

/** Convenience: build context from baseByPair then evaluate (used by unit tests). */
function evaluateStrategy(def, asOfMs, baseByPair) {
  return evaluateAt(def, asOfMs, buildContext(def, baseByPair));
}

module.exports = {
  evaluateStrategy, evaluateAt, buildContext,
  baselineMs, latestCompletedInterval, entryCandlesFor, causalCut, lastClosedIdx, STATUS,
};
