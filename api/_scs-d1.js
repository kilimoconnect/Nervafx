'use strict';

/**
 * SCS — Section 4: D1 direction engine (pure, deterministic).
 *
 * Walks completed D1 (trading-day) candles left→right and maintains bias:
 *   BULLISH  after a valid bullish D1 BOS; the responsible prior swing low is the
 *            protected D1 low; invalidated only if a later completed D1 candle
 *            CLOSES below it (wicks never invalidate).
 *   BEARISH  inverse.
 *   NEUTRAL  no confirmed directional BOS, or a protected level broken without a
 *            valid opposite BOS, or conflicting structure.
 * Updates only at a completed D1 close. H4/H1 can never override it.
 */

const { D1_DIRECTION, REJECTION } = require('./_scs-config');
const { atrSeries, swingHighs, swingLows, detectBOS, latestSwingBefore } = require('./_scs-indicators');

function neutralState(reason) {
  return { direction: D1_DIRECTION.NEUTRAL, protectedLevel: null, protectedSwingId: null, bosTime: null, bosLevel: null, invalidationReason: reason };
}

function evaluateD1(d1) {
  const atr = atrSeries(d1);
  const highs = swingHighs(d1);
  const lows = swingLows(d1);
  let st = neutralState(REJECTION.D1_NEUTRAL);

  for (let i = 0; i < d1.length; i++) {
    const a = atr[i]; if (!(a > 0)) continue;
    const candle = d1[i];

    // 1. invalidation of the current protected level (completed close only; wicks ignored)
    if (st.direction === D1_DIRECTION.BULLISH && candle.close < st.protectedLevel) st = neutralState(REJECTION.D1_PROTECTED_BROKEN);
    else if (st.direction === D1_DIRECTION.BEARISH && candle.close > st.protectedLevel) st = neutralState(REJECTION.D1_PROTECTED_BROKEN);

    // 2. new BOS on this completed candle
    const swHi = latestSwingBefore(highs, i);
    const swLo = latestSwingBefore(lows, i);
    const bull = swHi ? detectBOS(candle, swHi, a, 1, undefined, true) : null;   // structural break (no entry gates)
    const bear = swLo ? detectBOS(candle, swLo, a, -1, undefined, true) : null;

    if (bull && bull.bos && bear && bear.bos) { st = neutralState(REJECTION.D1_CONFLICT); continue; }

    if (bull && bull.bos) {
      const protLow = latestSwingBefore(lows, swHi.index);
      if (protLow) st = { direction: D1_DIRECTION.BULLISH, protectedLevel: protLow.price, protectedSwingId: protLow.id, bosTime: candle.openMs, bosLevel: swHi.price, invalidationReason: REJECTION.NONE };
    } else if (bear && bear.bos) {
      const protHigh = latestSwingBefore(highs, swLo.index);
      if (protHigh) st = { direction: D1_DIRECTION.BEARISH, protectedLevel: protHigh.price, protectedSwingId: protHigh.id, bosTime: candle.openMs, bosLevel: swLo.price, invalidationReason: REJECTION.NONE };
    }
  }

  return {
    ...st,
    updatedAt: d1.length ? d1[d1.length - 1].endMs || d1[d1.length - 1].openMs : null,
    bosTimeIso: st.bosTime != null ? new Date(st.bosTime).toISOString() : null,
    // exposed for H1 target-room (nearest opposing D1 swing) and diagnostics
    swingHighs: highs, swingLows: lows, atrLast: d1.length ? atr[d1.length - 1] : null,
  };
}

module.exports = { evaluateD1, neutralState };
