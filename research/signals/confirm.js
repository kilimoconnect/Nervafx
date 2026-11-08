'use strict';

/**
 * Confirmation rules (spec §5) over the latest COMPLETED confirmation candle:
 *   Today → H1, Week → H4, Month → D1.
 *
 * For a shortlisted candidate A/B:
 *   - BUY passes iff  rA_confirm > 0  AND  rB_confirm < 0
 *                     AND A appreciated vs >= 5 of 7 counterparts
 *                     AND B depreciated vs >= 5 of 7 counterparts.
 *   - SELL reverses every condition.
 * Zero returns never count as directional support. Breadth is participation, not seven
 * independent confirmations. The previous completed confirmation candle is reported for
 * context only (no extra persistence requirement in v1).
 *
 * The per-currency confirmation return is ln(idx_end/idx_start) which telescopes to the
 * zero-sum 1/8 currency return over the candle interval. Breadth is computed from the
 * ACTUAL oriented pair returns over the SAME interval (resolution-generic, not the
 * M15-hardcoded comparison helper).
 */

const { legsFor } = require('./config');
const { idxAtOrBefore } = require('../comparison/index-build');

/** Last pair close at or before time t, from base candles ({openMs,close}) spaced baseMs. */
function pairCloseAtOrBefore(candles, t, baseMs) {
  if (!candles || !candles.length) return null;
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; const cm = candles[m].openMs + baseMs; if (cm <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? null : candles[ans].close;
}

/** Currency return over (startMs → endMs] from the prebuilt index (carry at boundaries). */
function currencyReturn(built, ccy, startMs, endMs) {
  const a = idxAtOrBefore(built, ccy, startMs), b = idxAtOrBefore(built, ccy, endMs);
  if (!a || !b || !(a.value > 0) || !(b.value > 0)) return null;
  return Math.log(b.value / a.value);
}

/** Oriented 7-leg breadth for a currency over [startMs,endMs] from raw pair closes. */
function breadth(ccy, candlesByPair, startMs, endMs, baseMs, unchangedTol) {
  const legs = legsFor(ccy);
  let up = 0, down = 0, flat = 0; const missing = [], per = [];
  for (const leg of legs) {
    const cs = candlesByPair[leg.pair];
    const a = pairCloseAtOrBefore(cs, startMs, baseMs), b = pairCloseAtOrBefore(cs, endMs, baseMs);
    if (a == null || b == null || !(a > 0) || !(b > 0)) { missing.push(leg.pair); per.push({ pair: leg.pair, counterpart: leg.counterpart, oriented: null, cls: 'missing' }); continue; }
    const oriented = leg.sign * Math.log(b / a);
    const cls = Math.abs(oriented) <= unchangedTol ? 'flat' : (oriented > 0 ? 'up' : 'down');
    if (cls === 'up') up++; else if (cls === 'down') down++; else flat++;
    per.push({ pair: leg.pair, counterpart: leg.counterpart, oriented, cls });
  }
  return { up, down, flat, valid: legs.length - missing.length, missing, per };
}

/**
 * Evaluate confirmation for one candidate.
 *   candidate: {pair, a, b, bias}            (bias from selection: 'BUY'|'SELL'|'none')
 *   built:     index built at the base resolution covering the confirmation interval
 *   candlesByPair, baseMs: raw base candles + their interval (for breadth)
 *   interval:  {startMs, endMs} of the latest completed confirmation candle
 * Returns {pass, reasons[], readings:{A,B}, breadth:{A,B}}.
 */
function evaluateCandidate(candidate, built, candlesByPair, baseMs, interval, params) {
  const { a, b, bias } = candidate;
  const tol = params.unchangedPairLogret, need = params.breadthMin;
  const rA = currencyReturn(built, a, interval.startMs, interval.endMs);
  const rB = currencyReturn(built, b, interval.startMs, interval.endMs);
  const brA = breadth(a, candlesByPair, interval.startMs, interval.endMs, baseMs, tol);
  const brB = breadth(b, candlesByPair, interval.startMs, interval.endMs, baseMs, tol);
  const readings = { A: { ccy: a, ret: rA }, B: { ccy: b, ret: rB } };
  const breadthOut = { A: brA, B: brB };
  const reasons = [];

  if (bias !== 'BUY' && bias !== 'SELL') { reasons.push('no directional bias'); return { pass: false, reasons, readings, breadth: breadthOut }; }
  if (rA == null || rB == null) { reasons.push('missing confirmation return'); return { pass: false, reasons, readings, breadth: breadthOut }; }

  if (bias === 'BUY') {
    if (!(rA > 0)) reasons.push(a + ' confirmation return not positive');
    if (!(rB < 0)) reasons.push(b + ' confirmation return not negative');
    if (!(brA.up >= need)) reasons.push(a + ' appreciated vs only ' + brA.up + '/7 (need ' + need + ')');
    if (!(brB.down >= need)) reasons.push(b + ' depreciated vs only ' + brB.down + '/7 (need ' + need + ')');
  } else {
    if (!(rA < 0)) reasons.push(a + ' confirmation return not negative');
    if (!(rB > 0)) reasons.push(b + ' confirmation return not positive');
    if (!(brA.down >= need)) reasons.push(a + ' depreciated vs only ' + brA.down + '/7 (need ' + need + ')');
    if (!(brB.up >= need)) reasons.push(b + ' appreciated vs only ' + brB.up + '/7 (need ' + need + ')');
  }
  return { pass: reasons.length === 0, reasons, readings, breadth: breadthOut };
}

module.exports = { pairCloseAtOrBefore, currencyReturn, breadth, evaluateCandidate };
