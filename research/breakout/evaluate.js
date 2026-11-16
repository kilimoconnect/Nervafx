'use strict';

/**
 * Orchestrates the Evolution-based breakout methodology (v2) at any as-of timestamp,
 * deterministically and with NO look-ahead. The same functions run live (forward) and in
 * replay, so rules cannot drift.
 *
 * buildContext() aggregates each pair's H1 into the strategy's trigger-TF candles (and the
 * higher-TF structure, kept only as diagnostic context) and builds the zero-sum 1/8 Evolution
 * index from M15 ONCE. Every as-of query derives the currency CONDITION from the index at the
 * latest M15 close ≤ T (memoised), re-checks the §7 spread-expansion gate, and evaluates the
 * PRESERVED break-of-structure trigger on the trigger TF. Causal prefixes (closeMs ≤ cutoff)
 * guarantee appending later candles never changes an earlier decision.
 *
 * snapshotAt(ctx, T) returns, all cut to T:
 *   - condition (= strength alias) : the 8 currencies' Evolution condition at the M15 close ≤ T
 *   - pairStates                   : each pair's latest HTF break (DIAGNOSTIC; not a direction input)
 *   - qualification                : all 28 pairs' BUY/SELL/exclude + the spread-expansion result
 *   - triggerEvals                 : per expanding candidate, the latest completed trigger candle,
 *                                    with condition + spread RE-CHECKED at that trigger candle's close
 *   - signals                      : the confirmed BUY/SELL signals at that trigger close
 */

const { PAIRS, strategyDef, TF } = require('./config');
const { aggregateEat } = require('./candles');
const { latestBreakUpto } = require('./breakout');
const { qualifyPairs } = require('./qualify');
const { triggerBreakUpto, decideSignal } = require('./trigger');
const { conditionAll, spreadExpands } = require('./condition');
const { buildIndices } = require('../comparison/index-build');
const { CURRENCIES } = require('../comparison/config');

/** Count of candles with closeMs ≤ cutoffMs (binary search; candles ascending by closeMs). */
function prefixEnd(candles, cutoffMs) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].closeMs <= cutoffMs) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The 8-currency "insufficient" condition map (no index / before any data). */
function insufficientAll() {
  const out = {};
  for (const c of CURRENCIES) out[c] = { currency: c, classification: 'insufficient', complete: false, score: null, fast: { available: false }, slow: { available: false }, paceChange: null };
  return out;
}

/** Largest M15 close time in the index ≤ T (null if none). */
function m15CloseAtOrBefore(built, T) {
  const tl = built.timeline; let lo = 0, hi = tl.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (tl[m] <= T) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? null : tl[ans];
}

/**
 * Precompute everything an as-of query needs for one strategy.
 * @param def   strategyDef (carries condition windows, params, version)
 * @param data  { h1ByPair, m15ByPair } — H1 drives triggers + diagnostic HTF; M15 drives the index.
 */
function buildContext(def, data) {
  data = data || {};
  const h1ByPair = data.h1ByPair || {};
  const m15ByPair = data.m15ByPair || {};
  const trigByPair = {}, dirByPair = {};
  for (const pair of PAIRS) {
    const h1 = h1ByPair[pair] || [];
    trigByPair[pair] = aggregateEat(h1, def.triggerTf);
    dirByPair[pair] = aggregateEat(h1, def.dirTf);     // HTF structure — diagnostic only in v2
  }
  const built = buildIndices(m15ByPair);               // {ok:false} when too few synchronized M15
  return { def, cond: def.condition, params: def.params, trigByPair, dirByPair, m15ByPair, built, _condCache: new Map() };
}

/** Currency condition effective at T (Evolution index at the M15 close ≤ T; memoised by that close). */
function conditionAt(ctx, T) {
  if (!ctx.built || !ctx.built.ok) return insufficientAll();
  const closeMs = m15CloseAtOrBefore(ctx.built, T);
  if (closeMs == null) return insufficientAll();
  const hit = ctx._condCache.get(closeMs);
  if (hit) return hit;
  const cond = conditionAll(ctx.built, ctx.m15ByPair, closeMs, ctx.cond, ctx.params);
  ctx._condCache.set(closeMs, cond);
  return cond;
}

const briefBreadth = (b) => (b ? { appreciated: b.appreciated, depreciated: b.depreciated, unchanged: b.unchanged, valid: b.coverage ? b.coverage.valid : null } : null);

/** Build the immutable signal record (used identically by live and replay → parity). */
function buildSignalRecord(ctx, cand, tb, condAtTrig, dirState, triggerCloseMs, spreadAtTrig) {
  const def = ctx.def;
  const cb = condAtTrig[cand.base] || {}, cq = condAtTrig[cand.quote] || {};
  const snapshot = {};
  for (const c of Object.keys(condAtTrig)) {
    const s = condAtTrig[c];
    snapshot[c] = {
      classification: s.classification, score: s.score, complete: s.complete, periodPct: s.periodPct,
      fast: s.fast ? { M: s.fast.M, direction: s.fast.direction, signedEff: s.fast.signedEff, breadth: briefBreadth(s.fast.breadth) } : null,
      slow: s.slow ? { M: s.slow.M, direction: s.slow.direction, signedEff: s.slow.signedEff } : null,
    };
  }
  return {
    strategyKey: def.key, version: def.version, settingsVersion: def.version,
    pair: cand.pair, direction: cand.direction, base: cand.base, quote: cand.quote,
    dirTf: def.dirTf, triggerTf: def.triggerTf,
    triggerOpenMs: tb.candle.openMs, triggerCloseMs,
    brokenBoundary: tb.boundary, brokenLevel: tb.level, referenceClose: tb.candle.close,
    baseScore: cb.score == null ? null : cb.score, quoteScore: cq.score == null ? null : cq.score,
    conditionSnapshot: snapshot, strengthSnapshot: snapshot,          // strengthSnapshot = alias for the existing column
    candidateDetail: { spread: spreadAtTrig || null, baseClass: cb.classification, quoteClass: cq.classification },
    breakoutDetail: dirState && dirState.direction !== 0 ? {
      note: 'higher-TF structure (diagnostic; not a v2 direction input)',
      direction: dirState.direction, brokenBoundary: dirState.brokenBoundary, brokenLevel: dirState.brokenLevel,
      breakOpenMs: dirState.breakOpenMs, breakCloseMs: dirState.breakCloseMs, ageCandles: dirState.ageCandles, breakOhlc: dirState.breakOhlc,
    } : null,
    triggerDetail: { candle: tb.candle, prev: tb.prev },
    publishedAtMs: triggerCloseMs, infoCutoffMs: triggerCloseMs, evoSnapshotMs: triggerCloseMs, marketCloseMs: triggerCloseMs,
    dedupKey: [def.key, def.version, cand.pair, triggerCloseMs].join('|'),
  };
}

/** Full as-of snapshot for one strategy. */
function snapshotAt(ctx, asOfMs) {
  const def = ctx.def;
  const condition = conditionAt(ctx, asOfMs);                       // Evolution snapshot FIRST (coincident-close ordering)

  const pairStates = {};
  for (const pair of PAIRS) {
    const arr = ctx.dirByPair[pair];
    const st = latestBreakUpto(arr, prefixEnd(arr, asOfMs));
    pairStates[pair] = { pair, timeframe: def.dirTf, ...st };
  }

  const q = qualifyPairs(condition);
  // §7: keep candidates whose directional spread is widening over BOTH windows
  const candidates = q.all.map((c) => {
    if (!c.direction) return { ...c, spread: null };
    return { ...c, spread: spreadExpands(ctx.built || {}, c.base, c.quote, asOfMs, ctx.cond, c.direction, ctx.params) };
  });
  const expanding = candidates.filter((c) => c.direction && c.spread && c.spread.expanding);

  const triggerEvals = [], signals = [];
  for (const cand of expanding) {
    const arr = ctx.trigByPair[cand.pair];
    const tb = triggerBreakUpto(arr, prefixEnd(arr, asOfMs));
    let condAtTrig = condition, triggerCloseMs = null, spreadAtTrig = cand.spread;
    if (tb.candle) {
      triggerCloseMs = tb.candle.closeMs;
      condAtTrig = conditionAt(ctx, triggerCloseMs);
      spreadAtTrig = spreadExpands(ctx.built || {}, cand.base, cand.quote, triggerCloseMs, ctx.cond, cand.direction, ctx.params);
    }
    const decision = decideSignal(cand.direction, tb, condAtTrig, cand.base, cand.quote);
    const spreadOk = !!(spreadAtTrig && spreadAtTrig.expanding);
    const fired = decision.signal && spreadOk;
    triggerEvals.push({
      pair: cand.pair, candidateDir: cand.direction, base: cand.base, quote: cand.quote,
      triggerTf: def.triggerTf, triggerCloseMs, trigger: tb, decision, spread: spreadAtTrig,
      spreadOk, fired: !!fired,
      baseClassAtTrigger: (condAtTrig[cand.base] || {}).classification,
      quoteClassAtTrigger: (condAtTrig[cand.quote] || {}).classification,
    });
    if (fired) signals.push(buildSignalRecord(ctx, cand, tb, condAtTrig, pairStates[cand.pair], triggerCloseMs, spreadAtTrig));
  }

  const complete = Object.values(condition).filter((s) => s.complete).length;
  return {
    strategyKey: def.key, version: def.version, dirTf: def.dirTf, triggerTf: def.triggerTf,
    asOfMs,
    condition, strength: condition,                                  // strength = alias so legacy consumers keep working
    pairStates, qualification: { all: candidates, qualified: expanding }, triggerEvals, signals,
    dataCompleteness: {
      complete: complete === CURRENCIES.length, currenciesComplete: complete,
      knownPairs: Object.values(pairStates).filter((p) => p.direction !== 0).length,
      indexAvailable: !!(ctx.built && ctx.built.ok),
    },
  };
}

module.exports = {
  buildContext, snapshotAt, conditionAt, buildSignalRecord, prefixEnd, m15CloseAtOrBefore,
  // back-compat alias: replay + older callers referenced strengthAt
  strengthAt: conditionAt,
  strategyDef, TF,
};
