'use strict';

/**
 * Entry trigger (spec §6) + ATR stop / plan (spec §7), applied to a strategy's ACTUAL
 * pair entry candles (M15 / H1 / H4). Never uses synthetic currency-index candles for
 * entry or stop placement.
 *
 * Let t = latest completed entry candle (entryCandles[last]). Needs t-2, t-1, t.
 * BUY trigger:  t-2 & t-1 bearish (close<open); t bullish (close>open); close[t] > high[t-1].
 * SELL trigger: t-2 & t-1 bullish (close>open); t bearish (close<open); close[t] < low[t-1].
 *
 * Reject if ATR unavailable/nonpositive, candle-t range > maxRangeAtrMult*ATR, required
 * candles incomplete, or the resulting stop is on the wrong side / zero distance.
 */

const { wilderATR } = require('./atr');

function isBull(c) { return c.close > c.open; }
function isBear(c) { return c.close < c.open; }

/**
 * Evaluate the trigger for a direction at the last candle of entryCandles.
 *   entryCandles: ascending [{time,open,high,low,close}] real pair candles at the entry TF
 *   direction: 'BUY' | 'SELL'
 *   params: strategy params (atrPeriod, stopAtrMult, maxRangeAtrMult, targetR, entryDevAtrMult)
 * Returns {pass, reasons[], plan?} where plan has the frozen entry/stop/target/ATR fields.
 */
function evaluateTrigger(entryCandles, direction, params) {
  const reasons = [];
  const n = entryCandles.length;
  if (n < Math.max(3, params.atrPeriod + 1)) return { pass: false, reasons: ['insufficient entry candles'] };

  const t = entryCandles[n - 1], t1 = entryCandles[n - 2], t2 = entryCandles[n - 3];
  for (const [nm, c] of [['t', t], ['t-1', t1], ['t-2', t2]]) {
    if (!(c && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close))) reasons.push('incomplete candle ' + nm);
  }
  if (reasons.length) return { pass: false, reasons };

  const { last: atr } = wilderATR(entryCandles, params.atrPeriod);
  return buildPlan(t2, t1, t, atr, direction, params, intervalOf(entryCandles));
}

/**
 * Core trigger + plan from the three candles and a PRE-COMPUTED ATR (Wilder, through t).
 * Pure and allocation-light so the backfill can call it per entry candle without
 * recomputing ATR over the whole series each time.
 */
function buildPlan(t2, t1, t, atr, direction, params, entryMs) {
  const reasons = [];
  if (!(atr > 0)) return { pass: false, reasons: ['ATR unavailable or nonpositive'], atr };

  const range = t.high - t.low;
  if (range > params.maxRangeAtrMult * atr) reasons.push('candle-t range ' + range.toFixed(6) + ' exceeds ' + params.maxRangeAtrMult + '*ATR');

  if (direction === 'BUY') {
    if (!isBear(t2)) reasons.push('t-2 not bearish');
    if (!isBear(t1)) reasons.push('t-1 not bearish');
    if (!isBull(t)) reasons.push('t not bullish');
    if (!(t.close > t1.high)) reasons.push('close[t] not above high[t-1]');
  } else if (direction === 'SELL') {
    if (!isBull(t2)) reasons.push('t-2 not bullish');
    if (!isBull(t1)) reasons.push('t-1 not bullish');
    if (!isBear(t)) reasons.push('t not bearish');
    if (!(t.close < t1.low)) reasons.push('close[t] not below low[t-1]');
  } else {
    reasons.push('invalid direction');
  }
  if (reasons.length) return { pass: false, reasons, atr };

  // Stop from the 3-candle extreme with ATR buffer.
  const lowestLow = Math.min(t2.low, t1.low, t.low);
  const highestHigh = Math.max(t2.high, t1.high, t.high);
  const referenceEntry = t.close;
  let stop, target;
  if (direction === 'BUY') {
    stop = lowestLow - params.stopAtrMult * atr;
    if (!(stop < referenceEntry)) return { pass: false, reasons: ['stop not below entry'], atr };
  } else {
    stop = highestHigh + params.stopAtrMult * atr;
    if (!(stop > referenceEntry)) return { pass: false, reasons: ['stop not above entry'], atr };
  }
  const risk = Math.abs(referenceEntry - stop);
  if (!(risk > 0)) return { pass: false, reasons: ['invalid (zero) stop distance'], atr };
  target = direction === 'BUY' ? referenceEntry + params.targetR * risk : referenceEntry - params.targetR * risk;

  return {
    pass: true, reasons: [], atr,
    plan: {
      direction,
      atr,
      referenceEntry,
      referenceRisk: risk,                                   // reference R at the trigger close (pre-fill)
      maxDeviation: params.entryDevAtrMult * atr,
      fixedStop: stop,
      indicativeTarget: target,
      entryCloseMs: t.time + entryMs,                        // close time of candle t
      triggerCandles: {
        t2: pick(t2), t1: pick(t1), t: pick(t),
        closesBeyond: direction === 'BUY' ? t1.high : t1.low,
      },
      rangeAtrRatio: range / atr,
    },
  };
}

function pick(c) { return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }
/** Infer the candle interval from the last two candle open times (fallback 0). */
function intervalOf(cs) { return cs.length >= 2 ? (cs[cs.length - 1].time - cs[cs.length - 2].time) : 0; }

module.exports = { evaluateTrigger, buildPlan, isBull, isBear };
