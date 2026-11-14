'use strict';

/**
 * Orchestrates the breakout methodology at any as-of timestamp, deterministically and with
 * NO look-ahead. The same functions run live (forward) and in replay, so rules cannot drift.
 *
 * buildContext() aggregates each pair's H1 into the strategy's direction-TF and trigger-TF
 * candle arrays ONCE (full, uncut) and precomputes a piecewise-constant currency-strength
 * timeline (strength only changes when some pair's latest direction break changes). Every
 * as-of query then uses causal prefixes (closeMs ≤ cutoff), so appending later candles never
 * changes an earlier decision.
 *
 * snapshotAt(ctx, T) returns, all cut to T:
 *   - pairStates   : each pair's latest qualifying direction break
 *   - strength      : the 8 currency scores/classifications
 *   - qualification : all 28 pairs' BUY/SELL/exclude
 *   - triggerEvals  : per qualified pair, the latest completed trigger candle evaluated
 *                     (qualification RE-CHECKED at that trigger candle's close)
 *   - signals       : the confirmed BUY/SELL signals at that trigger close
 */

const { PAIRS, strategyDef, validThreshold, TF } = require('./config');
const { aggregateEat } = require('./candles');
const { latestBreakUpto } = require('./breakout');
const { currencyStrength, allComplete } = require('./strength');
const { qualifyPairs } = require('./qualify');
const { triggerBreakUpto, decideSignal } = require('./trigger');
const { classifyBreak } = require('./breakout');

/** Count of candles with closeMs ≤ cutoffMs (binary search; candles ascending by closeMs). */
function prefixEnd(candles, cutoffMs) {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].closeMs <= cutoffMs) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Precompute everything an as-of query needs for one strategy.
 * @param def            strategyDef (carries dirTf, triggerTf, version, params)
 * @param h1ByPair       { pair: ascending H1 rows } for all 28 pairs
 */
function buildContext(def, h1ByPair) {
  const thr = validThreshold((def.params || {}).strongThreshold);
  const dirByPair = {}, trigByPair = {};
  for (const pair of PAIRS) {
    const h1 = h1ByPair[pair] || [];
    dirByPair[pair] = aggregateEat(h1, def.dirTf);
    trigByPair[pair] = aggregateEat(h1, def.triggerTf);
  }
  const ctx = { def, thr, dirByPair, trigByPair, _strengthCache: new Map() };
  ctx.allInsufficient = currencyStrength({}, thr);
  ctx.timeline = buildStrengthTimeline(ctx);
  return ctx;
}

/** Direction of every pair as of cutoffMs (causal prefix). */
function pairDirAsOf(ctx, cutoffMs) {
  const pd = {};
  for (const pair of PAIRS) pd[pair] = latestBreakUpto(ctx.dirByPair[pair], prefixEnd(ctx.dirByPair[pair], cutoffMs)).direction;
  return pd;
}

/** Full currency strength as of cutoffMs (recomputed; memoised by cutoff). */
function strengthAsOf(ctx, cutoffMs) {
  const hit = ctx._strengthCache.get(cutoffMs);
  if (hit) return hit;
  const st = currencyStrength(pairDirAsOf(ctx, cutoffMs), ctx.thr);
  ctx._strengthCache.set(cutoffMs, st);
  return st;
}

/**
 * Strength is piecewise-constant: it changes only when some pair's latest direction break
 * changes, i.e. at a direction-TF break candle's close. Precompute the segment boundaries
 * (union of those closes) and the strength on each segment. strengthAt() then binary-searches.
 */
function buildStrengthTimeline(ctx) {
  const bps = new Set();
  for (const pair of PAIRS) {
    const cs = ctx.dirByPair[pair];
    for (let i = 1; i < cs.length; i++) if (classifyBreak(cs[i], cs[i - 1]).direction !== 0) bps.add(cs[i].closeMs);
  }
  const times = Array.from(bps).sort((a, b) => a - b);
  return times.map((t) => ({ fromMs: t, strength: strengthAsOf(ctx, t) }));
}

/** Currency strength effective at ms (piecewise-constant lookup; no look-ahead). */
function strengthAt(ctx, ms) {
  const segs = ctx.timeline;
  if (!segs.length || ms < segs[0].fromMs) return ctx.allInsufficient;
  let lo = 0, hi = segs.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].fromMs <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return segs[ans].strength;
}

/** Build the immutable signal record (used identically by live and replay → parity). */
function buildSignalRecord(def, cand, tb, strengthAtTrig, dirState, triggerCloseMs) {
  const sb = strengthAtTrig[cand.base] || {}, sq = strengthAtTrig[cand.quote] || {};
  const snapshot = {};
  for (const c of Object.keys(strengthAtTrig)) {
    const s = strengthAtTrig[c];
    snapshot[c] = { score: s.score, classification: s.classification, bull: s.bull, bear: s.bear, complete: s.complete };
  }
  return {
    strategyKey: def.key, version: def.version, settingsVersion: def.version,
    pair: cand.pair, direction: cand.direction, base: cand.base, quote: cand.quote,
    dirTf: def.dirTf, triggerTf: def.triggerTf,
    triggerOpenMs: tb.candle.openMs, triggerCloseMs,
    brokenBoundary: tb.boundary, brokenLevel: tb.level, referenceClose: tb.candle.close,
    baseScore: sb.score, quoteScore: sq.score,
    strengthSnapshot: snapshot,
    breakoutDetail: dirState ? {
      direction: dirState.direction, brokenBoundary: dirState.brokenBoundary, brokenLevel: dirState.brokenLevel,
      breakOpenMs: dirState.breakOpenMs, breakCloseMs: dirState.breakCloseMs, ageCandles: dirState.ageCandles, breakOhlc: dirState.breakOhlc,
    } : null,
    triggerDetail: { candle: tb.candle, prev: tb.prev },
    publishedAtMs: triggerCloseMs, infoCutoffMs: triggerCloseMs,
    dedupKey: [def.key, def.version, cand.pair, triggerCloseMs].join('|'),
  };
}

/** Full as-of snapshot for one strategy. */
function snapshotAt(ctx, asOfMs) {
  const def = ctx.def;
  const strength = strengthAt(ctx, asOfMs);
  const pairStates = {};
  for (const pair of PAIRS) {
    const arr = ctx.dirByPair[pair];
    const st = latestBreakUpto(arr, prefixEnd(arr, asOfMs));
    pairStates[pair] = { pair, timeframe: def.dirTf, ...st };
  }
  const q = qualifyPairs(strength);
  const triggerEvals = [], signals = [];
  for (const cand of q.qualified) {
    const arr = ctx.trigByPair[cand.pair];
    const tb = triggerBreakUpto(arr, prefixEnd(arr, asOfMs));
    let strengthAtTrig = strength, triggerCloseMs = null;
    if (tb.candle) { triggerCloseMs = tb.candle.closeMs; strengthAtTrig = strengthAt(ctx, triggerCloseMs); }
    const decision = decideSignal(cand.direction, tb, strengthAtTrig, cand.base, cand.quote);
    triggerEvals.push({
      pair: cand.pair, candidateDir: cand.direction, base: cand.base, quote: cand.quote,
      triggerTf: def.triggerTf, triggerCloseMs, trigger: tb, decision,
      baseClassAtTrigger: (strengthAtTrig[cand.base] || {}).classification,
      quoteClassAtTrigger: (strengthAtTrig[cand.quote] || {}).classification,
    });
    if (decision.signal) signals.push(buildSignalRecord(def, cand, tb, strengthAtTrig, pairStates[cand.pair], triggerCloseMs));
  }
  return {
    strategyKey: def.key, version: def.version, dirTf: def.dirTf, triggerTf: def.triggerTf,
    asOfMs, threshold: ctx.thr,
    pairStates, strength, qualification: q, triggerEvals, signals,
    dataCompleteness: { complete: allComplete(strength), knownPairs: Object.values(pairStates).filter((p) => p.direction !== 0).length },
  };
}

module.exports = { buildContext, snapshotAt, strengthAt, strengthAsOf, buildSignalRecord, prefixEnd, strategyDef, TF };
