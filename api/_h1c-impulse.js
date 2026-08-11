'use strict';

/**
 * NervaFX H1 Continuation Engine — latest reference-impulse detector.
 *
 * A reference impulse is the LATEST valid directional move immediately before a
 * pullback. Two separate impulses are never merged into one long impulse. H1
 * only, closed candles only, no lookahead: a window ending at index e uses only
 * candles <= e (ATR and structure included).
 *
 * `evaluateWindow` scores one explicit window with an explicit ATR (pure, easy
 * to unit-test). `detectReferenceImpulse` sweeps windows of 2–6 candles and
 * applies the selection rules.
 */

const {
  safeDivide, clamp, trueRange, candleDirection,
} = require('./_h1c-math');
const { ATR_PERIOD } = require('./_h1c-constants');

// ── Qualification thresholds (from the Portion 3 spec) ───────────────────────
const MIN_NET_ATR = 1.20;
const MIN_EFFICIENCY = 0.50;
const MIN_BODY_SHARE = 0.65;
const MIN_EXTENSION = 2;
const STRUCT_LOOKBACK = 5;
const MIN_WIN = 2;
const MAX_WIN = 6;

// No-merge guards.
const COUNTER_BODY_ATR = 0.15;      // a "meaningful" counter candle body, in ATR (assumption).
const INTERNAL_COUNTER_ATR = 0.50;  // reject a window whose internal counter-move >= this.

// Quality mapping caps (assumptions, documented in the report).
const DISP_CAP_ATR = 3.0;           // netMoveATR -> 100% at 3 ATR.
const BREAK_CAP_ATR = 1.0;          // break distance -> 100% at 1 ATR beyond structure.

/** Rolling ATR(period): out[i] = simple average of the last `period` true ranges ending at i. */
function rollingAtr(candles, period) {
  const n = candles.length;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) tr[i] = trueRange(candles[i], candles[i - 1].close);
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 1; i < n; i++) {
    sum += tr[i];
    if (i - period >= 1) sum -= tr[i - period];   // keep tr[i-period+1 .. i]
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

/**
 * Evaluate one candidate window candles[s..e] against an explicit ATR value.
 * Returns a qualifying impulse object or null. Uses candles[s-1] for the first
 * true range and candles[s-5..s-1] for the structure break, so s must be >= 5.
 */
function evaluateWindow(candles, s, e, atrValue) {
  if (s < STRUCT_LOOKBACK || e >= candles.length || e < s) return null;
  if (!atrValue || atrValue <= 0) return null;

  const first = candles[s], last = candles[e];
  const signed = last.close - first.open;
  const dir = signed > 0 ? 1 : signed < 0 ? -1 : 0;
  if (dir === 0) return null;

  const netMove = Math.abs(signed);
  const netMoveATR = netMove / atrValue;

  // Efficiency = netMove / sum of true ranges inside the window.
  let sumTR = 0;
  for (let i = s; i <= e; i++) sumTR += trueRange(candles[i], candles[i - 1].close);
  const efficiency = safeDivide(netMove, sumTR, 0);

  // Directional body share = dir-aligned body / total absolute body.
  let dirBody = 0, totBody = 0;
  for (let i = s; i <= e; i++) {
    const b = Math.abs(candles[i].close - candles[i].open);
    totBody += b;
    if (candleDirection(candles[i]) === dir) dirBody += b;
  }
  const directionalBodyShare = safeDivide(dirBody, totBody, 0);

  // Extension candles: bullish close above prior high (BUY) / bearish close below prior low (SELL).
  let extension = 0;
  for (let i = s; i <= e; i++) {
    const c = candles[i], prev = candles[i - 1];
    if (dir > 0 && candleDirection(c) === 1 && c.close > prev.high) extension++;
    else if (dir < 0 && candleDirection(c) === -1 && c.close < prev.low) extension++;
  }

  // Structure break vs the 5 completed candles before the impulse.
  let structureLevel;
  let structureBreak;
  if (dir > 0) {
    let hi = -Infinity;
    for (let i = s - STRUCT_LOOKBACK; i <= s - 1; i++) hi = Math.max(hi, candles[i].high);
    structureLevel = hi; structureBreak = last.close > hi;
  } else {
    let lo = Infinity;
    for (let i = s - STRUCT_LOOKBACK; i <= s - 1; i++) lo = Math.min(lo, candles[i].low);
    structureLevel = lo; structureBreak = last.close < lo;
  }

  // No-merge guard A: two consecutive meaningful counter-direction candles.
  let mergeReject = false;
  let prevCounter = false;
  for (let i = s; i <= e; i++) {
    const c = candles[i];
    const isCounter = candleDirection(c) === -dir &&
      Math.abs(c.close - c.open) >= COUNTER_BODY_ATR * atrValue;
    if (isCounter && prevCounter) { mergeReject = true; break; }
    prevCounter = isCounter;
  }

  // No-merge guard B: internal counter-move (deepest retrace from the running
  // favourable extreme to a LATER candle) >= 0.50 ATR.
  if (!mergeReject) {
    if (dir > 0) {
      let runHigh = candles[s].high, maxAdv = 0;
      for (let i = s + 1; i <= e; i++) {
        maxAdv = Math.max(maxAdv, runHigh - candles[i].low);
        if (candles[i].high > runHigh) runHigh = candles[i].high;
      }
      if (maxAdv >= INTERNAL_COUNTER_ATR * atrValue) mergeReject = true;
    } else {
      let runLow = candles[s].low, maxAdv = 0;
      for (let i = s + 1; i <= e; i++) {
        maxAdv = Math.max(maxAdv, candles[i].high - runLow);
        if (candles[i].low < runLow) runLow = candles[i].low;
      }
      if (maxAdv >= INTERNAL_COUNTER_ATR * atrValue) mergeReject = true;
    }
  }

  const qualifies =
    netMoveATR >= MIN_NET_ATR &&
    efficiency >= MIN_EFFICIENCY &&
    directionalBodyShare >= MIN_BODY_SHARE &&
    extension >= MIN_EXTENSION &&
    structureBreak &&
    !mergeReject;
  if (!qualifies) return null;

  // Impulse Quality 0–100.
  const dispScore = clamp(netMoveATR / DISP_CAP_ATR, 0, 1);
  const effScore = clamp(efficiency, 0, 1);
  const bodyScore = clamp(directionalBodyShare, 0, 1);
  const breakDist = dir > 0 ? last.close - structureLevel : structureLevel - last.close;
  const breakScore = clamp(breakDist / (BREAK_CAP_ATR * atrValue), 0, 1);
  const quality = Math.round(100 * (0.35 * dispScore + 0.25 * effScore + 0.20 * bodyScore + 0.20 * breakScore));

  let winHigh = -Infinity, winLow = Infinity;
  for (let i = s; i <= e; i++) { winHigh = Math.max(winHigh, candles[i].high); winLow = Math.min(winLow, candles[i].low); }

  return {
    direction: dir,
    startIdx: s, endIdx: e,
    startTime: first.time, endTime: last.time,
    startPrice: first.open, endPrice: last.close,
    high: winHigh, low: winLow,
    candleCount: e - s + 1,
    netMove, netMoveATR,
    efficiency,
    directionalBodyShare,
    structureLevel,
    quality,
    extensionCandles: extension,
    atr: atrValue,
    previousAlignedImpulseCount: 0,   // filled by detectReferenceImpulse
  };
}

/**
 * Detect the reference impulse — the latest qualifying impulse ending at or
 * before searchEndIdx. Selection: most-recent end wins; ties → higher quality;
 * ties → shorter window. `previousAlignedImpulseCount` counts distinct earlier
 * aligned qualifying impulses (context only, never merged).
 *
 * @param {Array} candles  ascending closed H1 candles (from sanitizeH1).
 * @param {{searchEndIdx?:number, atrPeriod?:number}} [opts]
 * @returns {Object|null}
 */
function detectReferenceImpulse(candles, opts = {}) {
  const period = opts.atrPeriod || ATR_PERIOD;
  const n = Array.isArray(candles) ? candles.length : 0;
  const searchEndIdx = opts.searchEndIdx != null ? Math.min(opts.searchEndIdx, n - 1) : n - 1;
  if (n < period + 1 + STRUCT_LOOKBACK + MIN_WIN) return null;

  const atrAt = rollingAtr(candles, period);
  const qualifying = [];
  for (let e = searchEndIdx; e >= STRUCT_LOOKBACK + MIN_WIN - 1; e--) {
    const atrValue = atrAt[e];
    if (!atrValue) continue;
    for (let L = MIN_WIN; L <= MAX_WIN; L++) {
      const s = e - L + 1;
      if (s < STRUCT_LOOKBACK) break;
      const cand = evaluateWindow(candles, s, e, atrValue);
      if (cand) qualifying.push(cand);
    }
  }
  const ref = selectReference(qualifying);
  if (!ref) return null;

  // Context: distinct earlier aligned qualifying end candles.
  const seenEnds = new Set();
  for (const q of qualifying) {
    if (q.direction === ref.direction && q.endIdx < ref.startIdx) seenEnds.add(q.endIdx);
  }
  ref.previousAlignedImpulseCount = seenEnds.size;
  return ref;
}

/**
 * Selection rules over qualifying candidates: most-recent end wins; ties break
 * on higher quality; further ties prefer the shorter window (so an older impulse
 * is never absorbed). Pure — unit-tested directly.
 */
function selectReference(qualifying) {
  if (!Array.isArray(qualifying) || qualifying.length === 0) return null;
  return qualifying.slice().sort((a, b) =>
    b.endIdx - a.endIdx ||
    b.quality - a.quality ||
    (a.endIdx - a.startIdx) - (b.endIdx - b.startIdx)
  )[0];
}

module.exports = {
  rollingAtr,
  evaluateWindow,
  selectReference,
  detectReferenceImpulse,
  // exposed for tests / later portions
  THRESHOLDS: {
    MIN_NET_ATR, MIN_EFFICIENCY, MIN_BODY_SHARE, MIN_EXTENSION,
    STRUCT_LOOKBACK, MIN_WIN, MAX_WIN, COUNTER_BODY_ATR, INTERNAL_COUNTER_ATR,
  },
};
