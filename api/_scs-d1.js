'use strict';

/**
 * SCS — Section 4: D1 direction engine (pure, deterministic).
 *
 * The bias is read from the MOST RECENT COMPLETED daily candle (the last one to
 * close at 17:00 New York) versus the day before it. If it is currently the 28th,
 * the direction is based on the 27th's completed candle vs the 26th:
 *   BULLISH  the last completed D1 candle CLOSED ABOVE the previous day's high
 *            (previous day's low is the protected level).
 *   BEARISH  the last completed D1 candle CLOSED BELOW the previous day's low
 *            (previous day's high is the protected level).
 *   NEUTRAL  the last completed candle stayed inside the previous day's range
 *            (no break) — no directional bias.
 * Wicks never count — a close beyond is required. The forming (incomplete) day is
 * never used (the candle set is already completed-only). H4/H1 cannot override it.
 * Confirmed swings are exposed for H1 target-room but do not drive the bias.
 */

const { D1_DIRECTION, REJECTION } = require('./_scs-config');
const { atrSeries, swingHighs, swingLows } = require('./_scs-indicators');

function neutralState(reason) {
  return { direction: D1_DIRECTION.NEUTRAL, protectedLevel: null, protectedSwingId: null, bosTime: null, bosLevel: null, invalidationReason: reason };
}

function evaluateD1(d1) {
  const atr = atrSeries(d1);
  const common = {
    swingHighs: swingHighs(d1), swingLows: swingLows(d1), atrLast: d1.length ? atr[d1.length - 1] : null,
    updatedAt: d1.length ? d1[d1.length - 1].endMs || d1[d1.length - 1].openMs : null,
    referenceDay: d1.length ? (d1[d1.length - 1].session || new Date(d1[d1.length - 1].openMs).toISOString().slice(0, 10)) : null,
    previousDay: d1.length >= 2 ? (d1[d1.length - 2].session || new Date(d1[d1.length - 2].openMs).toISOString().slice(0, 10)) : null,
  };

  if (d1.length < 2) return { ...neutralState(REJECTION.D1_NEUTRAL), ...common, bosTimeIso: null };

  const last = d1[d1.length - 1], prev = d1[d1.length - 2];
  let st;
  if (last.close > prev.high) {           // last completed candle broke the previous day's high
    st = { direction: D1_DIRECTION.BULLISH, protectedLevel: prev.low, protectedSwingId: `D1-LOW-${prev.openMs}`, bosTime: last.openMs, bosLevel: prev.high, invalidationReason: REJECTION.NONE };
  } else if (last.close < prev.low) {     // last completed candle broke the previous day's low
    st = { direction: D1_DIRECTION.BEARISH, protectedLevel: prev.high, protectedSwingId: `D1-HIGH-${prev.openMs}`, bosTime: last.openMs, bosLevel: prev.low, invalidationReason: REJECTION.NONE };
  } else {
    st = neutralState(REJECTION.D1_NEUTRAL); // inside day — no break, no direction
  }

  return { ...st, ...common, bosTimeIso: st.bosTime != null ? new Date(st.bosTime).toISOString() : null };
}

module.exports = { evaluateD1, neutralState };
