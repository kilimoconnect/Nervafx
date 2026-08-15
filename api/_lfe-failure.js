'use strict';

/**
 * NervaFX Liquidity Failure Engine — H1 attack & failure detection (Portion 4).
 *
 * Detects all four setups against pre-existing liquidity levels:
 *   IMMEDIATE / DELAYED  ×  FAILED BUYERS (→SELL) / FAILED SELLERS (→BUY)
 *
 * Deterministic and lookahead-free: only the completed candles handed in are
 * examined. A delayed breakout whose follow-up candles have not yet closed stays
 * DELAYED_FAILURE_PENDING — the future is never consulted. Emits events only;
 * M15 confirmation is Portion 5.
 */

const {
  HOUR_MS, CONFIG, ORIENTATION, SETUP_TYPE, FAILED_SIDE, DIRECTION, EVENT_STATE,
} = require('./_lfe-constants');
const { candleFeatures, zoneWidth, pipSizeFor } = require('./_lfe-math');
const { appendTransition } = require('./_lfe-persist');

const closeMs = (c) => c.openMs + HOUR_MS;
const iso = (ms) => new Date(ms).toISOString();
const body = (c) => Math.abs(c.close - c.open);
const rangeOf = (c, pip) => Math.max(c.high - c.low, pip);

function atrAtIdx(atr, i, atrNow) {
  return atr && atr[i] != null ? atr[i] : atrNow;
}

// ── Attack detection (A / B) ────────────────────────────────────────────────
/**
 * Buyer ('BUY') or seller ('SELL') attack over the latest 1–6 candles ending at
 * index i. Requires ≥0.80 ATR of directional movement plus one of: two candles
 * the right way, one strong body ≥0.45 ATR, or a strong breakout candle.
 */
function detectAttack(candles, i, atrAt, dir, cfg) {
  cfg = cfg || CONFIG;
  if (!atrAt) return null;
  const need = cfg.attack.minDistanceAtr * atrAt;
  for (let w = cfg.attack.lookbackMin; w <= cfg.attack.lookbackMax; w++) {
    const start = i - w + 1;
    if (start < 0) break;
    const win = candles.slice(start, i + 1);
    let move;
    if (dir === 'BUY') {
      let lo = Infinity;
      for (const c of win) lo = Math.min(lo, c.low);
      move = candles[i].high - lo;
    } else {
      let hi = -Infinity;
      for (const c of win) hi = Math.max(hi, c.high);
      move = hi - candles[i].low;
    }
    if (move < need) continue;
    if (attackSubOk(win, candles[i], atrAt, dir, cfg)) {
      return { attackStartMs: win[0].openMs, windowLen: w, moveAtr: move / atrAt };
    }
  }
  return null;
}

function attackSubOk(win, bc, atrAt, dir, cfg) {
  const dirOk = dir === 'BUY' ? (c) => c.close > c.open : (c) => c.close < c.open;
  const pip = 1e-9;
  let count = 0;
  let strongBody = false;
  for (const c of win) {
    if (dirOk(c)) {
      count += 1;
      if (body(c) >= cfg.attack.strongBodyAtr * atrAt) strongBody = true;
    }
  }
  const strongBreakout = dirOk(bc)
    && body(bc) >= cfg.attack.breakoutBodyAtr * atrAt
    && body(bc) / rangeOf(bc, pip) >= cfg.attack.breakoutBodyRatio;
  return count >= 2 || strongBody || strongBreakout;
}

// ── Event construction ──────────────────────────────────────────────────────
function eventKey(pair, direction, centre, setupType, anchorMs, cfg) {
  return `${pair}:${direction}:${centre.toFixed(5)}:${setupType}:${anchorMs}:${cfg.version}`;
}

function measure(c, f, atrAt, pip) {
  return {
    body: body(c),
    range: c.high - c.low,
    bodyATR: f.bodyATR,
    rangeATR: f.rangeATR,
    bodyRatio: body(c) / rangeOf(c, pip),
    closeLocation: f.closeLocation,
  };
}

function baseEvent(level, direction, failedSide, setupType, key, atrAt, zw, L, cfg) {
  return {
    eventKey: key,
    pair: level.pair,
    levelId: level.id != null ? level.id : null,
    levelType: level.levelType,
    levelCentre: level.centre,
    levelScore: level.score,
    failedSide,
    direction,
    setupType,
    attackStartMs: null,
    breachAtMs: null,
    breakoutAtMs: null,
    failureAtMs: null,
    h1Atr: atrAt,
    zoneWidth: zw,
    zoneLow: L - zw,
    zoneHigh: L + zw,
    sweepExtreme: null,
    breakout: null,
    failure: null,
    returnOffset: null,
    strong: false,
    qualityPoints: 0,
    state: null,
    configVersion: cfg.version,
    transitions: [],
  };
}

function immediateEvent(candles, i, level, L, zw, direction, failedSide, atk, atrAt, pip, cfg) {
  const c = candles[i];
  const f = candleFeatures(c, atrAt, pip);
  const anchor = c.openMs;
  const failAt = closeMs(c);
  const key = eventKey(level.pair, direction, level.centre, SETUP_TYPE.IMMEDIATE, anchor, cfg);
  const ev = baseEvent(level, direction, failedSide, SETUP_TYPE.IMMEDIATE, key, atrAt, zw, L, cfg);
  ev.attackStartMs = atk.attackStartMs;
  ev.breachAtMs = failAt;
  ev.failureAtMs = failAt;
  ev.failure = measure(c, f, atrAt, pip);
  ev.sweepExtreme = failedSide === FAILED_SIDE.BUYERS ? c.high : c.low;
  const strong = isStrongReturn(c, f, atrAt, pip, failedSide, cfg);
  ev.strong = strong;
  ev.state = EVENT_STATE.FAILURE_CONFIRMED;
  ev.qualityPoints = cfg.failure.points.returnNext + (strong ? cfg.failure.points.strongBonus : 0);
  appendTransition(ev.transitions, { signalKey: key, fromState: null, toState: ev.state, occurredAt: iso(failAt) });
  return ev;
}

function isStrongReturn(c, f, atrAt, pip, failedSide, cfg) {
  const s = cfg.failure.strong;
  const ratio = body(c) / rangeOf(c, pip);
  if (failedSide === FAILED_SIDE.BUYERS) {
    return body(c) >= s.bodyAtr * atrAt && ratio >= s.bodyRatio && f.closeLocation <= s.closeLocSell;
  }
  return body(c) >= s.bodyAtr * atrAt && ratio >= s.bodyRatio && f.closeLocation >= s.closeLocBuy;
}

/**
 * Delayed setup. The breakout/breakdown candle at index i has closed; the two
 * following candles are inspected ONLY if present in `candles` (i.e. already
 * closed ≤ evalMs). Returns an event whose state reflects the point-in-time.
 */
function delayedEvent(candles, atr, atrNow, i, level, L, zw, direction, failedSide, pip, cfg) {
  const bc = candles[i];
  const bf = candleFeatures(bc, atrAtIdx(atr, i, atrNow), pip);
  const isResistance = failedSide === FAILED_SIDE.BUYERS;
  const anchor = bc.openMs;
  const key = eventKey(level.pair, direction, level.centre, SETUP_TYPE.DELAYED, anchor, cfg);
  const ev = baseEvent(level, direction, failedSide, SETUP_TYPE.DELAYED, key, atrAtIdx(atr, i, atrNow), zw, L, cfg);
  ev.breakoutAtMs = closeMs(bc);
  ev.breachAtMs = closeMs(bc);
  ev.breakout = measure(bc, bf, atrAtIdx(atr, i, atrNow), pip);

  // Look only at follow-up candles that have actually closed.
  const followIdx = [i + 1, i + 2].filter((k) => k < candles.length);
  let sweep = isResistance ? bc.high : bc.low;
  for (const k of followIdx) sweep = isResistance ? Math.max(sweep, candles[k].high) : Math.min(sweep, candles[k].low);
  ev.sweepExtreme = sweep;

  appendTransition(ev.transitions, { signalKey: key, fromState: null, toState: EVENT_STATE.DELAYED_FAILURE_PENDING, occurredAt: iso(closeMs(bc)) });

  for (const k of followIdx) {
    const rc = candles[k];
    const atrK = atrAtIdx(atr, k, atrNow);
    const zwK = zoneWidth(atrK, 0);
    const rf = candleFeatures(rc, atrK, pip);
    const ratio = body(rc) / rangeOf(rc, pip);
    let isReturn;
    if (isResistance) {
      isReturn = rc.close < L - zwK && rc.close < rc.open
        && ratio >= cfg.failure.return.bodyRatio && rf.closeLocation <= cfg.failure.return.closeLocSell;
    } else {
      isReturn = rc.close > L + zwK && rc.close > rc.open
        && ratio >= cfg.failure.return.bodyRatio && rf.closeLocation >= cfg.failure.return.closeLocBuy;
    }
    if (isReturn) {
      const strong = isStrongReturn(rc, rf, atrK, pip, failedSide, cfg);
      ev.state = EVENT_STATE.FAILURE_CONFIRMED;
      ev.failureAtMs = closeMs(rc);
      ev.returnOffset = k - i;               // 1 = next candle, 2 = second
      ev.strong = strong;
      ev.failure = measure(rc, rf, atrK, pip);
      const base = ev.returnOffset === 1 ? cfg.failure.points.returnNext : cfg.failure.points.returnSecond;
      ev.qualityPoints = base + (strong ? cfg.failure.points.strongBonus : 0);
      appendTransition(ev.transitions, { signalKey: key, fromState: EVENT_STATE.DELAYED_FAILURE_PENDING, toState: ev.state, occurredAt: iso(closeMs(rc)) });
      return ev;
    }
  }

  // No return candle within the closed follow-ups.
  if (followIdx.length >= cfg.failure.delayedWindow) {
    const held = followIdx.every((k) => (isResistance ? candles[k].close > L + zw : candles[k].close < L - zw));
    ev.state = held ? EVENT_STATE.ACCEPTED : EVENT_STATE.EXPIRED;
    const at = closeMs(candles[followIdx[followIdx.length - 1]]);
    appendTransition(ev.transitions, { signalKey: key, fromState: EVENT_STATE.DELAYED_FAILURE_PENDING, toState: ev.state, occurredAt: iso(at) });
  } else {
    ev.state = EVENT_STATE.DELAYED_FAILURE_PENDING; // window not yet complete
  }
  return ev;
}

// ── Per-level scan ──────────────────────────────────────────────────────────
function firstIndexAtOrAfter(candles, ms) {
  if (ms == null) return 0;
  let i = 0;
  while (i < candles.length && candles[i].openMs < ms) i += 1;
  return i;
}

/**
 * All failure events for a single level against the candle series
 * (already bounded to completed candles ≤ evaluation time).
 */
function detectLevelFailures(candles, atr, atrNow, level, pair, cfg) {
  cfg = cfg || CONFIG;
  pair = level.pair || pair;
  level = Object.assign({ pair }, level);
  const pip = pipSizeFor(pair);
  const isResistance = level.orientation === ORIENTATION.RESISTANCE;
  const L = level.centre;
  const events = [];
  const start = firstIndexAtOrAfter(candles, level.availableAtMs);

  for (let i = start; i < candles.length; i++) {
    const atrAt = atrAtIdx(atr, i, atrNow);
    if (!atrAt) continue;
    const zw = zoneWidth(atrAt, 0);
    const c = candles[i];
    const f = candleFeatures(c, atrAt, pip);

    if (isResistance) {
      // C — Immediate failed buyers → SELL
      if (c.high > L + zw && c.close < L - zw
        && f.rangeATR >= cfg.failure.minRangeAtr && f.closeLocation <= cfg.failure.immediate.closeLocSell) {
        const atk = detectAttack(candles, i, atrAt, 'BUY', cfg);
        if (atk) { events.push(immediateEvent(candles, i, level, L, zw, DIRECTION.SELL, FAILED_SIDE.BUYERS, atk, atrAt, pip, cfg)); continue; }
      }
      // E — Delayed failed buyers → SELL (breakout candle)
      if (c.close > L + zw && f.closeLocation >= cfg.failure.breakout.closeLocSell) {
        const atk = detectAttack(candles, i, atrAt, 'BUY', cfg);
        if (atk) events.push(delayedEvent(candles, atr, atrNow, i, level, L, zw, DIRECTION.SELL, FAILED_SIDE.BUYERS, pip, cfg));
      }
    } else {
      // D — Immediate failed sellers → BUY
      if (c.low < L - zw && c.close > L + zw
        && f.rangeATR >= cfg.failure.minRangeAtr && f.closeLocation >= cfg.failure.immediate.closeLocBuy) {
        const atk = detectAttack(candles, i, atrAt, 'SELL', cfg);
        if (atk) { events.push(immediateEvent(candles, i, level, L, zw, DIRECTION.BUY, FAILED_SIDE.SELLERS, atk, atrAt, pip, cfg)); continue; }
      }
      // F — Delayed failed sellers → BUY (breakdown candle)
      if (c.close < L - zw && f.closeLocation <= cfg.failure.breakout.closeLocBuy) {
        const atk = detectAttack(candles, i, atrAt, 'SELL', cfg);
        if (atk) events.push(delayedEvent(candles, atr, atrNow, i, level, L, zw, DIRECTION.BUY, FAILED_SIDE.SELLERS, pip, cfg));
      }
    }
  }
  return events;
}

/** Merge event lists, deduping by eventKey (idempotent across repeated scans). */
function mergeEvents(existing, incoming) {
  const byKey = new Map();
  for (const e of existing) byKey.set(e.eventKey, e);
  for (const e of incoming) if (!byKey.has(e.eventKey)) byKey.set(e.eventKey, e);
  return Array.from(byKey.values());
}

/** Scan every level for one pair, returning deduped events. */
function detectFailures(levels, candles, atr, atrNow, pair, cfg) {
  let events = [];
  for (const level of levels) events = mergeEvents(events, detectLevelFailures(candles, atr, atrNow, level, pair, cfg));
  return events;
}

module.exports = {
  detectAttack,
  detectLevelFailures,
  detectFailures,
  mergeEvents,
  eventKey,
};
