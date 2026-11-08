'use strict';

/**
 * Shared, strictly-causal strategy evaluator (spec §4, §9). The SAME function drives
 * historical backfill and live forward processing. Given a strategy definition, an
 * information cutoff `asOfMs` (an entry-TF candle close), and the base candles, it:
 *
 *   1. reconstructs the period comparison through asOf (only data with close <= asOf),
 *   2. recomputes the top-3 ranking,
 *   3. applies confirmation using the latest FULLY COMPLETED confirmation candle,
 *   4. evaluates the completed entry candle t for the 3-candle trigger + ATR,
 *   5. returns a ranking snapshot, per-shortlist status, and any publishable signals.
 *
 * It never reads a candle whose close is after asOf (no look-ahead). Because log returns
 * telescope, one base series per strategy (M15 for today; H1 for week/month) supplies
 * selection, confirmation-boundary returns, breadth, and (aggregated) entry candles.
 */

const { CURRENCIES, PAIRS, TF_MS } = require('./config');
const { buildIndices } = require('../comparison/index-build');
const { aggregatePairs } = require('../comparison/aggregate');
const { dayStart, weekStart, monthStart } = require('../comparison/periods');
const { currencyReturns, rankPairs, topN } = require('./selection');
const { evaluateCandidate } = require('./confirm');
const { evaluateTrigger } = require('./trigger');

const STATUS = {
  INCOMPLETE: 'incomplete-data',
  NO_BIAS: 'no-directional-bias',
  WAIT_CONFIRM: 'waiting-for-confirmation',
  WAIT_TRIGGER: 'waiting-for-entry-trigger',
  PUBLISHED: 'signal-published',
};

/** Period baseline for a strategy's selection mode. */
function baselineMs(select, asOfMs) {
  if (select === 'day') return dayStart(asOfMs);
  if (select === 'week') return weekStart(asOfMs);
  if (select === 'month') return monthStart(asOfMs);
  throw new Error('unknown select period: ' + select);
}

/** Latest COMPLETED fixed-width candle interval (H1/H4/D1) as of asOfMs. */
function latestCompletedInterval(tfMs, asOfMs) {
  const end = Math.floor(asOfMs / tfMs) * tfMs;          // boundary at/just below asOf
  const confEnd = end === asOfMs ? asOfMs : end;          // completed candle ends here
  return { startMs: confEnd - tfMs, endMs: confEnd };
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

/** Entry candles at the entry TF, aggregated from the base, trimmed to completed ones <= asOf. */
function entryCandlesFor(baseCandles, entryTf, entryMs, asOfMs) {
  const agg = aggregatePairs(baseCandles, entryTf);     // {time(open),open,high,low,close,volume}
  const out = [];
  for (const c of agg) { if (c.time + entryMs <= asOfMs) out.push(c); else break; }
  return out;
}

/**
 * Evaluate one strategy at asOfMs.
 *   def: strategyDef(...)  ; baseByPair: { pair: base candles (entryBaseTf) } ascending.
 * Returns { ok, asOfMs, baselineMs, resolution, ranking, shortlist[], signals[], reason? }.
 */
function evaluateStrategy(def, asOfMs, baseByPair) {
  const baseMs = TF_MS[def.entryBaseTf];
  const cut = causalCut(baseByPair, baseMs, asOfMs);
  const built = buildIndices(cut, { baseMs });
  if (!built.ok) return { ok: false, asOfMs, reason: built.reason || 'insufficient synchronized candles', ranking: [], shortlist: [], signals: [] };

  const base = baselineMs(def.select, asOfMs);
  const returns = currencyReturns(built, CURRENCIES, base, asOfMs);
  const ranking = rankPairs(returns, PAIRS);
  const shortlist = topN(ranking, def.params.topN);

  const confInt = latestCompletedInterval(def.confirmMs, asOfMs);
  const prevInt = { startMs: confInt.startMs - def.confirmMs, endMs: confInt.startMs };
  const signals = [];
  const rows = [];

  for (const cand of shortlist) {
    const row = {
      rank: cand.rank, pair: cand.pair, a: cand.a, b: cand.b, bias: cand.bias,
      differential: cand.differential, status: STATUS.WAIT_CONFIRM, reasons: [],
    };
    if (cand.bias === 'none' || cand.differential == null) { row.status = cand.differential == null ? STATUS.INCOMPLETE : STATUS.NO_BIAS; rows.push(row); continue; }

    const conf = evaluateCandidate(cand, built, cut, baseMs, confInt, def.params);
    const confPrev = evaluateCandidate(cand, built, cut, baseMs, prevInt, def.params);
    row.confirmation = {
      interval: confInt, pass: conf.pass, reasons: conf.reasons,
      readings: conf.readings, breadth: conf.breadth,
      previous: { interval: prevInt, readings: confPrev.readings, breadth: confPrev.breadth },
    };
    if (!conf.pass) { row.status = STATUS.WAIT_CONFIRM; row.reasons = conf.reasons; rows.push(row); continue; }

    // Entry trigger on the pair's actual entry candles.
    const entryCandles = entryCandlesFor(cut[cand.pair] || [], def.entryTf, def.entryMs, asOfMs);
    const trig = evaluateTrigger(entryCandles, cand.bias, def.params);
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
      entryExpiryMs: plan.entryCloseMs + def.entryMs,       // one entry interval after close of t
      rangeAtrRatio: plan.rangeAtrRatio,
    });
    rows.push(row);
  }

  return {
    ok: true, asOfMs, baselineMs: base, resolution: built.resolution,
    ranking, shortlist: rows, signals,
    confirmInterval: confInt,
  };
}

module.exports = { evaluateStrategy, baselineMs, latestCompletedInterval, entryCandlesFor, causalCut, STATUS };
