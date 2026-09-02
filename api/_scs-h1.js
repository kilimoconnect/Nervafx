'use strict';

/**
 * SCS — Section 6: H1 trigger & trade candidate (pure, deterministic, paper-only).
 *
 * During an active aligned H4 pullback: a confirmed H1 swing is swept and reclaimed
 * (failed sellers/buyers); within the same or next 3 completed H1 candles a valid
 * displacement BOS forms; entry / stop / 2R target are derived and gated. A light
 * paper simulation walks completed candles for fill, expiry, target-before-entry,
 * target-hit and stop-hit. No live orders — data only.
 */

const { D1_DIRECTION, H4_STATE, H1_STATE, DIRECTION, SIGNAL_STATUS, REJECTION, CONFIG } = require('./_scs-config');
const { atrSeries, swingHighs, swingLows, detectBOS, latestSwingBefore, round } = require('./_scs-indicators');

function result(state, status, rejection, candidate, evidence) {
  return { triggered: !!candidate, state, status, rejection, candidate: candidate || null, evidence: evidence || {} };
}

function evaluateH1(h1, d1, h4res, evalMs, opts = {}) {
  const cfg = opts.config || CONFIG;
  const dir = d1.direction;
  if (dir === D1_DIRECTION.NEUTRAL) return result(H1_STATE.WAITING_SWEEP, SIGNAL_STATUS.REJECTED, REJECTION.D1_NEUTRAL, null);
  if (!h4res || h4res.state !== H4_STATE.PULLBACK_ACTIVE) return result(H1_STATE.WAITING_SWEEP, SIGNAL_STATUS.REJECTED, REJECTION.H4_NO_IMPULSE, null);

  const sign = dir === D1_DIRECTION.BULLISH ? 1 : -1;
  const atr = atrSeries(h1);
  const highs = swingHighs(h1);
  const lows = swingLows(h1);
  const last = h1.length - 1;
  const aH1 = atr[last];

  // 1–3: sweep + reclaim, then displacement BOS within the window.
  let sweepIdx = -1, bosIdx = -1, brokenHigh = null, sweptSwing = null, sawSweep = false;
  outer:
  for (let s = 0; s <= last; s++) {
    if (!(atr[s] > 0)) continue;
    const swept = sign > 0 ? latestSwingBefore(lows, s) : latestSwingBefore(highs, s);
    if (!swept) continue;
    const failed = sign > 0
      ? (h1[s].low < swept.price && h1[s].close > swept.price)      // swept low, closed back above → failed sellers
      : (h1[s].high > swept.price && h1[s].close < swept.price);    // swept high, closed back below → failed buyers
    if (!failed) continue;
    sawSweep = true;
    for (let b = s; b <= Math.min(last, s + cfg.h1SweepToBosWindow); b++) {
      if (!(atr[b] > 0)) continue;
      const brk = sign > 0 ? latestSwingBefore(highs, b) : latestSwingBefore(lows, b);
      if (!brk) continue;
      const ev = detectBOS(h1[b], brk, atr[b], sign);
      if (ev.bos) { sweepIdx = s; bosIdx = b; brokenHigh = brk; sweptSwing = swept; break outer; }
    }
  }
  if (bosIdx === -1) {
    return sawSweep
      ? result(H1_STATE.WAITING_BOS, SIGNAL_STATUS.REJECTED, REJECTION.H1_BOS_WINDOW_EXPIRED, null)
      : result(H1_STATE.WAITING_SWEEP, SIGNAL_STATUS.REJECTED, REJECTION.H1_NO_SWEEP, null);
  }

  // sweep→BOS extreme
  let sweepExt = sign > 0 ? Infinity : -Infinity;
  for (let j = sweepIdx; j <= bosIdx; j++) sweepExt = sign > 0 ? Math.min(sweepExt, h1[j].low) : Math.max(sweepExt, h1[j].high);

  const bodyMid = (h1[bosIdx].open + h1[bosIdx].close) / 2;
  const entry = sign > 0 ? Math.max(brokenHigh.price, bodyMid) : Math.min(brokenHigh.price, bodyMid);
  const entryType = entry === brokenHigh.price ? 'SWING_LEVEL' : 'BODY_MIDPOINT';
  const stop = sign > 0 ? sweepExt - cfg.h1StopBufferAtr * aH1 : sweepExt + cfg.h1StopBufferAtr * aH1;
  const R = sign > 0 ? entry - stop : stop - entry;
  const target = sign > 0 ? entry + cfg.targetR * R : entry - cfg.targetR * R;

  const candidate = {
    direction: sign > 0 ? DIRECTION.BUY : DIRECTION.SELL,
    entry: round(entry), stop: round(stop), target: round(target), r: round(R),
    rAtr: aH1 > 0 ? round(R / aH1) : 0, entryType, impulseId: h4res.impulse ? h4res.impulse.id : null,
    sweepExtreme: round(sweepExt), brokenSwingId: brokenHigh.id, bosCandleTime: h1[bosIdx].openMs,
  };
  const evidence = { sweepTime: h1[sweepIdx].openMs, sweptSwingId: sweptSwing.id, bosTime: h1[bosIdx].openMs, atrH1: aH1 };

  // Rejections that invalidate the candidate outright.
  if (!(R > 0)) return result(H1_STATE.REJECTED, SIGNAL_STATUS.REJECTED, REJECTION.STOP_TOO_TIGHT_VS_SPREAD, candidate, evidence);
  if (R > cfg.h1MaxStopAtr * aH1) return result(H1_STATE.REJECTED, SIGNAL_STATUS.REJECTED, REJECTION.STOP_TOO_WIDE, candidate, evidence);
  if (opts.spread > 0 && R < cfg.h1MinStopSpreadMult * opts.spread) return result(H1_STATE.REJECTED, SIGNAL_STATUS.REJECTED, REJECTION.STOP_TOO_TIGHT_VS_SPREAD, candidate, evidence);

  // Target room before the nearest opposing confirmed D1/H4 swing.
  if (Array.isArray(opts.opposingLevels) && opts.opposingLevels.length) {
    const beyond = opts.opposingLevels.filter((p) => (sign > 0 ? p > entry : p < entry));
    if (beyond.length) {
      const nearest = sign > 0 ? Math.min(...beyond) : Math.max(...beyond);
      if (Math.abs(nearest - entry) < cfg.targetR * R) return result(H1_STATE.REJECTED, SIGNAL_STATUS.REJECTED, REJECTION.INSUFFICIENT_TARGET_ROOM, candidate, evidence);
    }
  }

  // Paper simulation from the candle after the BOS.
  let state = H1_STATE.ENTRY_PENDING, status = SIGNAL_STATUS.PENDING, rejection = REJECTION.NONE;
  let filled = false, pendingAge = 0, fillTime = null;
  for (let j = bosIdx + 1; j <= last; j++) {
    if (!filled) {
      pendingAge += 1;
      const reachedEntry = sign > 0 ? h1[j].low <= entry : h1[j].high >= entry;
      const reachedTarget = sign > 0 ? h1[j].high >= target : h1[j].low <= target;
      if (reachedTarget && !reachedEntry) { state = H1_STATE.REJECTED; status = SIGNAL_STATUS.CANCELLED; rejection = REJECTION.TARGET_BEFORE_ENTRY; break; }
      if (reachedEntry) {
        filled = true; fillTime = h1[j].openMs; state = H1_STATE.ACTIVE; status = SIGNAL_STATUS.ACTIVE;
        if (sign > 0 ? h1[j].high >= target : h1[j].low <= target) { state = H1_STATE.COMPLETED; status = SIGNAL_STATUS.TARGET_HIT; break; }
        if (sign > 0 ? h1[j].low <= stop : h1[j].high >= stop) { state = H1_STATE.COMPLETED; status = SIGNAL_STATUS.STOP_HIT; break; }
      } else if (pendingAge >= cfg.h1PendingLifeCandles) {
        state = H1_STATE.REJECTED; status = SIGNAL_STATUS.EXPIRED; rejection = REJECTION.PENDING_EXPIRED; break;
      }
    } else {
      if (sign > 0 ? h1[j].high >= target : h1[j].low <= target) { state = H1_STATE.COMPLETED; status = SIGNAL_STATUS.TARGET_HIT; break; }
      if (sign > 0 ? h1[j].low <= stop : h1[j].high >= stop) { state = H1_STATE.COMPLETED; status = SIGNAL_STATUS.STOP_HIT; break; }
    }
  }

  return { triggered: true, state, status, rejection, candidate, evidence: { ...evidence, fillTime, pendingAge } };
}

module.exports = { evaluateH1 };
