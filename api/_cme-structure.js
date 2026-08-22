'use strict';

/**
 * NervaFX Currency Movement Engine — Break of Structure (BOS) layer (pure).
 *
 * A strong move is not structure-confirmed unless price closes DECISIVELY beyond
 * the immediately previous completed candle's high/low. All functions are pure
 * and deterministic; no DB/API/network. H1 is the structural authority; the 15M
 * layer only refines confidence/timing and can never replace a missing H1 BOS.
 */

const { BOS, CURRENCIES } = require('./_cme-constants');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round = (v) => Math.round(v * 100000) / 100000;
const r1 = (v) => Math.round(v * 10) / 10;

function strengthGrade(distATR) {
  if (distATR <= 0) return 'NO_BREAK';
  if (distATR < BOS.WEAK_ATR) return 'MARGINAL';
  if (distATR < BOS.STRONG_ATR) return 'WEAK';
  if (distATR < BOS.VERY_STRONG_ATR) return 'STRONG';
  if (distATR < BOS.EXPLOSIVE_ATR) return 'VERY_STRONG';
  return 'EXPLOSIVE';
}

/** Close quality in [0,1]: how near the close sits to the break extreme. Zero-range → 0. */
function closeQualityOf(c, dir) {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  return clamp01(dir > 0 ? (c.close - c.low) / range : (c.high - c.close) / range);
}

/**
 * Reduce the previous-N completed candles into a structure reference level:
 * the highest high and lowest low of the window. Accepts either an array of
 * candles (the structure window) or a single candle (legacy 1-bar reference).
 */
function structureRef(prev) {
  if (Array.isArray(prev)) {
    let high = -Infinity, low = Infinity, n = 0;
    for (const c of prev) {
      if (!c || !isFinite(c.high) || !isFinite(c.low)) continue;
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      n += 1;
    }
    return n ? { high, low, count: n } : null;
  }
  return prev ? { high: prev.high, low: prev.low, count: 1 } : null;
}

/**
 * Detect a Break of Structure on the latest completed candle vs the high/low of
 * the previous N completed candles (BOS.STRUCTURE_LOOKBACK). Pass `prev` as the
 * array of prior candles (the structure window); a single candle still works as
 * a 1-bar reference. `atr20` must be computed from candles ≤ current.
 * Timeframe-agnostic (used for both H1 and 15M).
 */
function detectBreak(cur, prev, atr20) {
  const ref = structureRef(prev);
  const res = {
    direction: 'NONE', breakType: 'NO_BREAK',
    previousHigh: ref ? ref.high : null, previousLow: ref ? ref.low : null, brokenLevel: null,
    lookback: ref ? ref.count : 0,
    closePrice: cur ? cur.close : null, breakDistancePrice: 0, breakDistanceATR: 0,
    closeQuality: 0, bodyATR: 0, atr20: atr20 || 0,
    strengthGrade: 'NO_BREAK', decisiveBreak: false, decisiveCloseQuality: false,
  };
  if (!cur || !ref || !(atr20 > 0)) return res;

  const bull = cur.close > ref.high;            // strict — equality is NO_BREAK
  const bear = cur.close < ref.low;
  const wickUp = cur.high > ref.high && cur.close <= ref.high;
  const wickDown = cur.low < ref.low && cur.close >= ref.low;

  if (bull) { res.direction = 'BULLISH'; res.breakType = 'CLOSE_BREAK'; res.brokenLevel = ref.high; res.breakDistancePrice = cur.close - ref.high; }
  else if (bear) { res.direction = 'BEARISH'; res.breakType = 'CLOSE_BREAK'; res.brokenLevel = ref.low; res.breakDistancePrice = ref.low - cur.close; }
  else if (wickUp || wickDown) { res.breakType = 'WICK_REJECTION'; }

  res.breakDistanceATR = res.breakDistancePrice > 0 ? round(res.breakDistancePrice / atr20) : 0;
  const dir = res.direction === 'BULLISH' ? 1 : res.direction === 'BEARISH' ? -1 : 0;
  res.closeQuality = dir !== 0 ? round(closeQualityOf(cur, dir)) : 0;
  res.bodyATR = round(Math.abs(cur.close - cur.open) / atr20);
  res.strengthGrade = strengthGrade(res.breakDistanceATR);
  res.decisiveBreak = res.direction !== 'NONE' && res.breakDistanceATR >= BOS.DECISIVE_ATR;
  res.decisiveCloseQuality = res.closeQuality >= BOS.DECISIVE_CLOSE_QUALITY;
  return res;
}

const detectH1BreakOfStructure = detectBreak;
const detect15MBreakOfStructure = detectBreak;

/** Unsigned 0–100 pair structure score (direction stored separately by the caller). */
function calculatePairStructureScore(bos) {
  if (!bos || bos.direction === 'NONE' || bos.breakType !== 'CLOSE_BREAK') return 0;
  const distanceComponent = clamp01(bos.breakDistanceATR / BOS.DISTANCE_CAP_ATR) * 100;
  const closeQualityComponent = clamp01(bos.closeQuality) * 100;
  const bodyComponent = clamp01(bos.bodyATR / BOS.BODY_CAP_ATR) * 100;
  return r1(BOS.PAIR_W.distance * distanceComponent + BOS.PAIR_W.closeQuality * closeQualityComponent + BOS.PAIR_W.body * bodyComponent);
}

/** This currency's structure direction from a pair's BOS (base +, quote inverts). */
function currencyDirFromPair(pair, currency, bosDirection) {
  const parts = pair.split('_');
  const isBase = parts[0] === currency;
  if (bosDirection === 'BULLISH') return isBase ? 'BULLISH' : 'BEARISH';
  if (bosDirection === 'BEARISH') return isBase ? 'BEARISH' : 'BULLISH';
  return 'NONE';
}

/**
 * Aggregate a currency's structure over its (up-to-7) pair BOS results.
 * @param {string} currency
 * @param {Array<{pair:string, bos:object, score:number}>} entries  valid pairs only
 */
function aggregateCurrencyStructure(currency, entries) {
  let bullishBreakCount = 0, bearishBreakCount = 0, decisiveBullishBreakCount = 0, decisiveBearishBreakCount = 0;
  let wickRejectionCount = 0, noBreakCount = 0;
  let bullishScoreSum = 0, bearishScoreSum = 0;
  const availablePairCount = entries.length;

  for (const e of entries) {
    const b = e.bos;
    if (b.breakType === 'WICK_REJECTION') { wickRejectionCount += 1; continue; }
    if (b.direction === 'NONE') { noBreakCount += 1; continue; }
    const cdir = currencyDirFromPair(e.pair, currency, b.direction);
    if (cdir === 'BULLISH') { bullishBreakCount += 1; bullishScoreSum += e.score; if (b.decisiveBreak) decisiveBullishBreakCount += 1; }
    else if (cdir === 'BEARISH') { bearishBreakCount += 1; bearishScoreSum += e.score; if (b.decisiveBreak) decisiveBearishBreakCount += 1; }
  }

  const denom = availablePairCount || 1;
  const bullishStructureBreadth = round(decisiveBullishBreakCount / denom);
  const bearishStructureBreadth = round(decisiveBearishBreakCount / denom);
  const bullishWeightedStructure = round(bullishScoreSum / denom);
  const bearishWeightedStructure = round(bearishScoreSum / denom);

  let classification, dominantDirection;
  if (decisiveBullishBreakCount > 0 && decisiveBearishBreakCount > 0) { classification = 'MIXED_STRUCTURE'; dominantDirection = 'MIXED'; }
  else {
    const d = Math.max(decisiveBullishBreakCount, decisiveBearishBreakCount);
    dominantDirection = decisiveBullishBreakCount > decisiveBearishBreakCount ? 'BULLISH' : decisiveBearishBreakCount > decisiveBullishBreakCount ? 'BEARISH' : 'NONE';
    classification = d === 0 ? 'NO_STRUCTURE' : d === 1 ? 'PAIR_SPECIFIC' : d <= 3 ? 'PARTIAL_STRUCTURE' : 'BROAD_STRUCTURE';
  }

  return {
    bullishBreakCount, bearishBreakCount, decisiveBullishBreakCount, decisiveBearishBreakCount,
    wickRejectionCount, noBreakCount, availablePairCount,
    bullishStructureBreadth, bearishStructureBreadth, bullishWeightedStructure, bearishWeightedStructure,
    classification, dominantDirection, coverage: round(availablePairCount / 7),
  };
}

/** Movement-oriented currency Structure Score (§10), unsigned 0–100. */
function currencyStructureScore(agg, movementDir) {
  const dir = movementDir > 0 ? 'BULLISH' : movementDir < 0 ? 'BEARISH' : 'NONE';
  const weighted = dir === 'BULLISH' ? agg.bullishWeightedStructure : dir === 'BEARISH' ? agg.bearishWeightedStructure : 0;
  const breadth = dir === 'BULLISH' ? agg.bullishStructureBreadth : dir === 'BEARISH' ? agg.bearishStructureBreadth : 0;
  const score = clamp01((BOS.CURRENCY_W.weighted * weighted + BOS.CURRENCY_W.breadth * breadth * 100) / 100) * 100;
  return {
    structureDirection: dir, structureScore: r1(score), structureBreadth: round(breadth), weightedStructure: round(weighted),
    structureClassification: agg.classification, structurePairCount: agg.availablePairCount, structureCoverage: agg.coverage,
    bullishBreakCount: agg.bullishBreakCount, bearishBreakCount: agg.bearishBreakCount,
    decisiveBreakCount: (dir === 'BULLISH' ? agg.decisiveBullishBreakCount : dir === 'BEARISH' ? agg.decisiveBearishBreakCount : 0),
    wickRejectionCount: agg.wickRejectionCount,
  };
}

/** Movement vs structure agreement class. */
function classifyStructureAgreement(movementScore, agg) {
  const moveDir = Math.sign(movementScore);
  const domSign = agg.dominantDirection === 'BULLISH' ? 1 : agg.dominantDirection === 'BEARISH' ? -1 : 0;
  const strongMove = Math.abs(movementScore) >= BOS.STRONG_MOVEMENT;
  const hasStructure = agg.classification === 'PARTIAL_STRUCTURE' || agg.classification === 'BROAD_STRUCTURE';

  if (moveDir === 0 && domSign === 0) return 'NEUTRAL';
  if (moveDir !== 0 && domSign !== 0 && moveDir !== domSign) return 'STRUCTURE_CONFLICT';
  if (moveDir !== 0 && hasStructure && domSign === moveDir) return 'STRUCTURE_CONFIRMED';
  if (strongMove && (agg.classification === 'NO_STRUCTURE' || agg.classification === 'PAIR_SPECIFIC' || domSign === 0)) return 'MOVEMENT_WITHOUT_STRUCTURE';
  if (domSign !== 0 && !strongMove) return 'STRUCTURE_LEADS_MOVEMENT';
  return 'NEUTRAL';
}

/** Confirmed Movement Score (§11): blends |movementScore| with structureScore, re-signed. */
function confirmedMovementScore(movementScore, structureScore) {
  const quality = clamp01((BOS.CONFIRMED_W.movement * Math.abs(movementScore) + BOS.CONFIRMED_W.structure * structureScore) / 100) * 100;
  return r1(Math.sign(movementScore) * quality);
}

/** Classify H1 vs 15M micro structure agreement. */
function classifyMicroAgreement(h1Dir, microDir, microDecisiveCount) {
  if (microDir == null) return 'MICRO_UNAVAILABLE';
  const h = h1Dir === 'BULLISH' ? 1 : h1Dir === 'BEARISH' ? -1 : 0;
  const m = microDir === 'BULLISH' ? 1 : microDir === 'BEARISH' ? -1 : 0;
  if (m === 0) return 'MICRO_MIXED';
  if (h === 0 && m !== 0 && microDecisiveCount > 0) return 'MICRO_LEADS_H1';   // micro break, no H1 break yet
  if (h !== 0 && m === h) return 'MICRO_CONFIRMS_H1';
  if (h !== 0 && m !== 0 && m !== h) return 'MICRO_DIVERGES_FROM_H1';
  return 'MICRO_MIXED';
}

module.exports = {
  strengthGrade, closeQualityOf, structureRef, detectBreak, detectH1BreakOfStructure, detect15MBreakOfStructure,
  calculatePairStructureScore, currencyDirFromPair, aggregateCurrencyStructure, currencyStructureScore,
  classifyStructureAgreement, confirmedMovementScore, classifyMicroAgreement,
};
