'use strict';

/**
 * SCS — Section 5: H4 impulse & pullback engine (pure, deterministic).
 *
 * Requires D1 alignment. A valid aligned H4 BOS starts an impulse; the responsible
 * prior H4 swing (low for bull, high for bear) is protected; the subsequent extreme
 * is the impulse extreme. Newer aligned impulses replace older ones. The impulse is
 * eligible for 12 completed H4 candles (array positions ⇒ weekends add zero). It
 * invalidates on D1 loss, a close beyond the protected level, expiry, or opposite
 * structure. A pullback needs ≥1 counter-trend H4 candle and ≥0.50 H4-ATR retrace
 * with no close beyond the protected level.
 */

const { D1_DIRECTION, H4_STATE, ORIGIN, REJECTION, CONFIG } = require('./_scs-config');
const { atrSeries, swingHighs, swingLows, detectBOS, latestSwingBefore } = require('./_scs-indicators');
const { sessionStartUtc, sessionLabel, weekdayOfDate } = require('./_scs-time');

function classifyOrigin(bosTime, evalMs) {
  const impS = sessionStartUtc(bosTime);
  const nowS = sessionStartUtc(evalMs - 1);
  if (impS === nowS) return ORIGIN.CURRENT_DAY;
  const [iy, im, id] = sessionLabel(impS).split('-').map(Number);
  const [ny, nm, nd] = sessionLabel(nowS).split('-').map(Number);
  const impCloseWd = weekdayOfDate(iy, im, id);   // 5 = Friday close
  const nowCloseWd = weekdayOfDate(ny, nm, nd);   // 1 = Monday close
  if (impCloseWd === 5 && nowCloseWd === 1) return ORIGIN.FRIDAY_CARRY;
  return ORIGIN.PREVIOUS_DAY;
}

function evaluateH4(h4, d1, evalMs) {
  const dir = d1.direction;
  if (dir === D1_DIRECTION.NEUTRAL || h4.length === 0) {
    return { state: H4_STATE.NO_IMPULSE, impulse: null, invalidationReason: dir === D1_DIRECTION.NEUTRAL ? REJECTION.H4_D1_MISALIGNED : REJECTION.H4_NO_IMPULSE };
  }
  const sign = dir === D1_DIRECTION.BULLISH ? 1 : -1;
  const atr = atrSeries(h4);
  const highs = swingHighs(h4);
  const lows = swingLows(h4);
  const lastIdx = h4.length - 1;

  // Collect valid aligned impulses; the newest replaces older ones.
  let imp = null;
  for (let i = 0; i < h4.length; i++) {
    const a = atr[i]; if (!(a > 0)) continue;
    const brokenSwing = sign > 0 ? latestSwingBefore(highs, i) : latestSwingBefore(lows, i);
    if (!brokenSwing) continue;
    const ev = detectBOS(h4[i], brokenSwing, a, sign);
    if (!ev.bos) continue;
    const prot = sign > 0 ? latestSwingBefore(lows, brokenSwing.index) : latestSwingBefore(highs, brokenSwing.index);
    if (!prot) continue;
    imp = { bosIndex: i, bosTime: h4[i].openMs, bosLevel: brokenSwing.price, protectedLevel: prot.price, protectedId: prot.id, id: `H4-${sign > 0 ? 'BULL' : 'BEAR'}-${h4[i].openMs}` };
  }
  if (!imp) return { state: H4_STATE.NO_IMPULSE, impulse: null, invalidationReason: REJECTION.H4_NO_IMPULSE };

  // Extreme after the BOS.
  let ext = sign > 0 ? -Infinity : Infinity, extIdx = imp.bosIndex;
  for (let j = imp.bosIndex; j <= lastIdx; j++) {
    if (sign > 0 && h4[j].high > ext) { ext = h4[j].high; extIdx = j; }
    if (sign < 0 && h4[j].low < ext) { ext = h4[j].low; extIdx = j; }
  }

  const ageCandles = lastIdx - imp.bosIndex;      // completed H4 candles since BOS (weekend-free)
  const aH4 = atr[lastIdx];

  // Invalidation: a completed close beyond the protected level.
  let broken = false;
  for (let j = imp.bosIndex + 1; j <= lastIdx; j++) {
    if (sign > 0 && h4[j].close < imp.protectedLevel) broken = true;
    if (sign < 0 && h4[j].close > imp.protectedLevel) broken = true;
  }

  let state, reason = REJECTION.NONE;
  let retrace = 0, hasCounter = false;
  for (let j = extIdx + 1; j <= lastIdx; j++) {
    const bearish = h4[j].close < h4[j].open, bullish = h4[j].close > h4[j].open;
    if (sign > 0 && bearish) hasCounter = true;
    if (sign < 0 && bullish) hasCounter = true;
  }
  // Retrace is measured only from candles AFTER the extreme (the pullback itself).
  if (sign > 0) { let lo = Infinity; for (let j = extIdx + 1; j <= lastIdx; j++) lo = Math.min(lo, h4[j].low); retrace = lo === Infinity ? 0 : ext - lo; }
  else { let hi = -Infinity; for (let j = extIdx + 1; j <= lastIdx; j++) hi = Math.max(hi, h4[j].high); retrace = hi === -Infinity ? 0 : hi - ext; }

  if (broken) { state = H4_STATE.INVALIDATED; reason = REJECTION.H4_PROTECTED_BROKEN; }
  else if (ageCandles > CONFIG.h4ImpulseLifeCandles) { state = H4_STATE.EXPIRED; reason = REJECTION.H4_EXPIRED; }
  else if (hasCounter && aH4 > 0 && retrace >= CONFIG.h4MinPullbackAtr * aH4) state = H4_STATE.PULLBACK_ACTIVE;
  else state = H4_STATE.IMPULSE_ACTIVE;

  return {
    state,
    invalidationReason: reason,
    impulse: {
      id: imp.id, bosTime: imp.bosTime, bosTimeIso: new Date(imp.bosTime).toISOString(),
      origin: classifyOrigin(imp.bosTime, evalMs), direction: dir,
      bosLevel: imp.bosLevel, protectedLevel: imp.protectedLevel, protectedId: imp.protectedId,
      extreme: ext, pullbackDepth: Math.max(0, retrace), pullbackDepthAtr: aH4 > 0 ? Math.max(0, retrace) / aH4 : 0,
      ageCandles, atrH4: aH4, state,
    },
  };
}

module.exports = { evaluateH4, classifyOrigin };
