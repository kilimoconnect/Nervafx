'use strict';

/**
 * SCS — Section 6: H1 trigger & trade candidate (pure, deterministic, paper-only).
 *
 * During an active aligned H4 pullback:
 *   BUY  — H1 closes ABOVE the most recent confirmed H1 swing high (formed during
 *          the pullback) by the required BOS distance; entry is a retracement back
 *          to that broken high; stop is below the most recent H1 pullback swing low;
 *          target is fixed 2R.
 *   SELL — the inverse.
 * There is NO sweep / failed-buyers-sellers / rejection-candle step — a confirmed
 * H1 close-break (BOS) is the only trigger. A light paper simulation walks
 * completed candles for the retracement fill, expiry, entry-missed, target-hit and
 * stop-hit. No live orders — data only.
 */

const { D1_DIRECTION, H4_STATE, H1_STATE, DIRECTION, SIGNAL_STATUS, REJECTION, CONFIG } = require('./_scs-config');
const { atrSeries, swingHighs, swingLows, detectBOS, latestSwingBefore, round } = require('./_scs-indicators');

function result(state, status, rejection, candidate, evidence, bosConfirmed) {
  return { triggered: !!candidate, state, status, rejection, candidate: candidate || null, evidence: evidence || {}, bosConfirmed: !!bosConfirmed };
}

function evaluateH1(h1, d1, h4res, evalMs, opts = {}) {
  const cfg = opts.config || CONFIG;
  const dir = d1.direction;
  if (dir === D1_DIRECTION.NEUTRAL) return result(H1_STATE.WAITING_BOS, SIGNAL_STATUS.REJECTED, REJECTION.D1_NEUTRAL, null, null, false);
  if (!h4res || h4res.state !== H4_STATE.PULLBACK_ACTIVE) return result(H1_STATE.WAITING_BOS, SIGNAL_STATUS.REJECTED, REJECTION.H4_NO_IMPULSE, null, null, false);

  const sign = dir === D1_DIRECTION.BULLISH ? 1 : -1;
  const atr = atrSeries(h1);
  const highs = swingHighs(h1);
  const lows = swingLows(h1);
  const last = h1.length - 1;
  const aH1 = atr[last];

  // Find the most recent valid H1 BOS beyond the latest confirmed swing (high for
  // bull, low for bear). A close-break only — wicks never qualify.
  let bosIdx = -1, brokenSwing = null;
  for (let b = 0; b <= last; b++) {
    if (!(atr[b] > 0)) continue;
    const brk = sign > 0 ? latestSwingBefore(highs, b) : latestSwingBefore(lows, b);
    if (!brk) continue;
    const ev = detectBOS(h1[b], brk, atr[b], sign);
    if (ev.bos) { bosIdx = b; brokenSwing = brk; }
  }
  if (bosIdx === -1) return result(H1_STATE.WAITING_BOS, SIGNAL_STATUS.REJECTED, REJECTION.H1_NO_BOS, null, null, false);

  // Stop reference = most recent confirmed H1 pullback swing (low for bull, high
  // for bear) BEFORE the BOS candle.
  const pullbackSwing = sign > 0 ? latestSwingBefore(lows, bosIdx) : latestSwingBefore(highs, bosIdx);
  if (!pullbackSwing) return result(H1_STATE.WAITING_BOS, SIGNAL_STATUS.REJECTED, REJECTION.H1_NO_BOS, null, null, false);

  // Entry = retracement to the broken H1 swing; stop = beyond the pullback swing.
  const entry = brokenSwing.price;
  const stop = sign > 0 ? pullbackSwing.price - cfg.h1StopBufferAtr * aH1 : pullbackSwing.price + cfg.h1StopBufferAtr * aH1;
  const R = sign > 0 ? entry - stop : stop - entry;
  const target = sign > 0 ? entry + cfg.targetR * R : entry - cfg.targetR * R;

  const candidate = {
    direction: sign > 0 ? DIRECTION.BUY : DIRECTION.SELL,
    entry: round(entry), stop: round(stop), target: round(target), r: round(R),
    rAtr: aH1 > 0 ? round(R / aH1) : 0, entryType: 'BOS_RETEST', impulseId: h4res.impulse ? h4res.impulse.id : null,
    brokenSwingId: brokenSwing.id, pullbackSwingId: pullbackSwing.id, bosCandleTime: h1[bosIdx].openMs,
  };
  const evidence = { bosTime: h1[bosIdx].openMs, brokenSwingId: brokenSwing.id, pullbackSwingId: pullbackSwing.id, atrH1: aH1 };

  // A BOS is confirmed from here on (bosConfirmed=true) even if the candidate is rejected.
  if (!(R > 0)) return result(H1_STATE.REJECTED, SIGNAL_STATUS.REJECTED, REJECTION.STOP_TOO_TIGHT_VS_SPREAD, candidate, evidence, true);
  if (R > cfg.h1MaxStopAtr * aH1) return result(H1_STATE.REJECTED, SIGNAL_STATUS.REJECTED, REJECTION.STOP_TOO_WIDE, candidate, evidence, true);
  if (opts.spread > 0 && R < cfg.h1MinStopSpreadMult * opts.spread) return result(H1_STATE.REJECTED, SIGNAL_STATUS.REJECTED, REJECTION.STOP_TOO_TIGHT_VS_SPREAD, candidate, evidence, true);

  if (Array.isArray(opts.opposingLevels) && opts.opposingLevels.length) {
    const beyond = opts.opposingLevels.filter((p) => (sign > 0 ? p > entry : p < entry));
    if (beyond.length) {
      const nearest = sign > 0 ? Math.min(...beyond) : Math.max(...beyond);
      if (Math.abs(nearest - entry) < cfg.targetR * R) return result(H1_STATE.REJECTED, SIGNAL_STATUS.REJECTED, REJECTION.INSUFFICIENT_TARGET_ROOM, candidate, evidence, true);
    }
  }

  // Paper simulation of the retracement fill from the candle after the BOS.
  let state = H1_STATE.ENTRY_PENDING, status = SIGNAL_STATUS.PENDING, rejection = REJECTION.NONE;
  let filled = false, pendingAge = 0, fillTime = null;
  for (let j = bosIdx + 1; j <= last; j++) {
    if (!filled) {
      pendingAge += 1;
      const reachedEntry = sign > 0 ? h1[j].low <= entry : h1[j].high >= entry;
      const reachedTarget = sign > 0 ? h1[j].high >= target : h1[j].low <= target;
      if (reachedTarget && !reachedEntry) { state = H1_STATE.REJECTED; status = SIGNAL_STATUS.CANCELLED; rejection = REJECTION.ENTRY_MISSED; break; }
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

  return { triggered: true, state, status, rejection, candidate, bosConfirmed: true, evidence: { ...evidence, fillTime, pendingAge } };
}

module.exports = { evaluateH1 };
