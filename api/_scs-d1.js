'use strict';

/**
 * SCS — Section 4: D1 direction engine (pure, deterministic).
 *
 * D1 bias is a Break of Structure of the PREVIOUS DAY'S high / low:
 *   BULLISH  when a completed D1 candle CLOSES ABOVE the previous day's high;
 *            the previous day's low becomes the protected level.
 *   BEARISH  when a completed D1 candle CLOSES BELOW the previous day's low;
 *            the previous day's high becomes the protected level.
 *   NEUTRAL  only until the first such break (or if a protected level is broken
 *            without an opposite break — rare, since a break the other way flips it).
 * Updates only at a completed D1 close (17:00 NY day). Wicks never count — a close
 * beyond the previous day's high/low is required. H4/H1 can never override it.
 * Confirmed swings are still exposed for H1 target-room, but do not drive the bias.
 */

const { D1_DIRECTION, REJECTION } = require('./_scs-config');
const { atrSeries, swingHighs, swingLows } = require('./_scs-indicators');

function neutralState(reason) {
  return { direction: D1_DIRECTION.NEUTRAL, protectedLevel: null, protectedSwingId: null, bosTime: null, bosLevel: null, invalidationReason: reason };
}

function evaluateD1(d1) {
  const atr = atrSeries(d1);
  let st = neutralState(REJECTION.D1_NEUTRAL);

  for (let i = 1; i < d1.length; i++) {
    const c = d1[i], prev = d1[i - 1];

    // 1. invalidation of the current protected level (completed close only; wicks ignored)
    if (st.direction === D1_DIRECTION.BULLISH && c.close < st.protectedLevel) st = neutralState(REJECTION.D1_PROTECTED_BROKEN);
    else if (st.direction === D1_DIRECTION.BEARISH && c.close > st.protectedLevel) st = neutralState(REJECTION.D1_PROTECTED_BROKEN);

    // 2. Break of the previous day's high / low (strict close beyond).
    if (c.close > prev.high) {
      st = { direction: D1_DIRECTION.BULLISH, protectedLevel: prev.low, protectedSwingId: `D1-LOW-${prev.openMs}`, bosTime: c.openMs, bosLevel: prev.high, invalidationReason: REJECTION.NONE };
    } else if (c.close < prev.low) {
      st = { direction: D1_DIRECTION.BEARISH, protectedLevel: prev.high, protectedSwingId: `D1-HIGH-${prev.openMs}`, bosTime: c.openMs, bosLevel: prev.low, invalidationReason: REJECTION.NONE };
    }
  }

  return {
    ...st,
    updatedAt: d1.length ? d1[d1.length - 1].endMs || d1[d1.length - 1].openMs : null,
    bosTimeIso: st.bosTime != null ? new Date(st.bosTime).toISOString() : null,
    // exposed for H1 target-room (nearest opposing D1 swing) and diagnostics
    swingHighs: swingHighs(d1), swingLows: swingLows(d1), atrLast: d1.length ? atr[d1.length - 1] : null,
  };
}

module.exports = { evaluateD1, neutralState };
