'use strict';

/**
 * SCS — history / market-replay view model (pure, deterministic, read-only).
 *
 * Given raw H1 candles and a requested historical time, snaps to the latest
 * COMPLETED H1 close, runs the exact production coordinator, and returns a fully
 * truncated, no-lookahead view for the three charts + state panel + timeline +
 * Why-No-Trade. Never reveals future candles, unconfirmed swings or future
 * outcomes. Orders are impossible here (read-only data).
 */

const time = require('./_scs-time');
const { swingHighs, swingLows } = require('./_scs-indicators');
const { runCoordinator, revalidateMonday } = require('./_scs-coordinator');
const { D1_DIRECTION, H4_STATE, H1_STATE, MARKET_STATE, ORIGIN, rejectionText, CONFIG } = require('./_scs-config');

const H1 = time.H1_MS;

/** Latest completed H1 close ≤ atMs (auto-correct a non-boundary selection). */
function snapToCompletedH1(atMs) { return Math.floor(atMs / H1) * H1; }

function swingsAsOf(candles) {
  return [
    ...swingHighs(candles).map((s) => ({ type: 'HIGH', price: s.price, time: s.time, openMs: s.openMs, id: s.id })),
    ...swingLows(candles).map((s) => ({ type: 'LOW', price: s.price, time: s.time, openMs: s.openMs, id: s.id })),
  ].sort((a, b) => a.openMs - b.openMs);
}

function buildTimeline(co, d1, h4, h1) {
  const ev = [];
  const push = (ms, tf, type, label) => { if (ms != null) ev.push({ ts: ms, tsIso: new Date(ms).toISOString(), tf, type, label }); };
  if (d1.bosTime != null) push(d1.bosTime, 'D1', 'BOS', `D1 ${d1.direction} BOS @ ${d1.bosLevel}`);
  if (h4.impulse) {
    push(h4.impulse.bosTime, 'H4', 'IMPULSE', `H4 impulse BOS (${h4.impulse.origin}) @ ${h4.impulse.bosLevel}`);
    if (h4.state === H4_STATE.PULLBACK_ACTIVE) push(h4.impulse.bosTime, 'H4', 'PULLBACK', `H4 pullback ${(h4.impulse.pullbackDepthAtr || 0).toFixed(2)} ATR`);
  }
  const e = h1 && h1.evidence ? h1.evidence : {};
  push(e.sweepTime, 'H1', 'SWEEP', 'H1 liquidity sweep');
  push(e.bosTime, 'H1', 'BOS', 'H1 displacement BOS');
  if (h1 && h1.candidate) push(e.bosTime, 'H1', 'CANDIDATE', `${h1.candidate.direction} candidate entry ${h1.candidate.entry}`);
  push(e.fillTime, 'H1', 'FILL', 'Entry filled');
  if (h1 && (h1.status === 'TARGET_HIT' || h1.status === 'STOP_HIT')) push(e.fillTime, 'H1', 'OUTCOME', h1.status);
  return ev.sort((a, b) => a.ts - b.ts);
}

/**
 * @param {object} input { h1raw, pair, at, tz?, spread?, normalSpread?, newsProvider?, openPositions? }
 */
function buildHistoryView(input) {
  const tz = input.tz || CONFIG.displayTzDefault;
  const requestedAt = input.at;
  const evalMs = snapToCompletedH1(requestedAt);

  const co = runCoordinator({
    h1raw: input.h1raw, evalMs, pair: input.pair,
    spread: input.spread, normalSpread: input.normalSpread,
    openPositions: input.openPositions, newsProvider: input.newsProvider, riskPct: input.riskPct,
  });

  const h1c = time.normalizeH1(input.h1raw, evalMs);
  const d1c = time.assembleD1(h1c, evalMs);
  const h4c = time.assembleH4(h1c, evalMs);
  const { d1, h4, h1 } = co;

  // Weekend view (Saturday / standalone Sunday): freeze on Friday's final state.
  let weekend = null;
  if (co.marketState === MARKET_STATE.WEEKEND_FROZEN) {
    weekend = {
      closed: true,
      message: 'MARKET CLOSED — SHOWING FRIDAY’S FINAL CONFIRMED STATE',
      fridayCloseUtc: new Date(time.fridayCloseUtc(evalMs - 7 * 24 * H1)).toISOString(),
      mondayReopenUtc: new Date(mondayReopenUtc(evalMs)).toISOString(),
    };
  }

  const fridayCarry = !!(h4.impulse && h4.impulse.origin === ORIGIN.FRIDAY_CARRY);
  const whyNoTrade = (!h1 || h1.state === H1_STATE.ACTIVE || h1.status === 'TARGET_HIT' || h1.status === 'STOP_HIT')
    ? null
    : { code: h1.rejection, text: rejectionText(h1.rejection), state: h1.state };

  return {
    ok: true,
    requestedAt: new Date(requestedAt).toISOString(),
    evalMs, evalIso: new Date(evalMs).toISOString(),
    evalLocal: time.partsInTz(evalMs, tz), tz, pair: input.pair,
    autoCorrected: requestedAt !== evalMs,
    marketState: co.marketState,
    ordersDisabled: true,                 // History Mode is always read-only
    weekend,
    fridayCarry,
    fridayCarryBanner: fridayCarry ? 'FRIDAY IMPULSE CARRIED FORWARD' : null,
    d1: {
      direction: d1.direction, protectedLevel: d1.protectedLevel, protectedSwingId: d1.protectedSwingId,
      bosLevel: d1.bosLevel, bosTime: d1.bosTimeIso, invalidationReason: d1.invalidationReason,
      candles: d1c, swings: swingsAsOf(d1c),
    },
    h4: {
      state: h4.state, invalidationReason: h4.invalidationReason,
      impulse: h4.impulse ? {
        origin: h4.impulse.origin, bosLevel: h4.impulse.bosLevel, protectedLevel: h4.impulse.protectedLevel,
        extreme: h4.impulse.extreme, pullbackDepth: h4.impulse.pullbackDepth, pullbackDepthAtr: h4.impulse.pullbackDepthAtr,
        ageCandles: h4.impulse.ageCandles, bosTime: h4.impulse.bosTimeIso,
      } : null,
      candles: h4c, swings: swingsAsOf(h4c),
    },
    h1: {
      state: h1 ? h1.state : null, status: h1 ? h1.status : null, rejection: h1 ? h1.rejection : null,
      candidate: h1 ? h1.candidate : null, evidence: h1 ? h1.evidence : null,
      candles: h1c.slice(-120), swings: swingsAsOf(h1c),   // last 120 H1 for the chart
    },
    statePanel: { d1Direction: d1.direction, h4State: h4.state, h1State: h1 ? h1.state : null, marketState: co.marketState },
    timeline: buildTimeline(co, d1, h4, h1),
    whyNoTrade,
    signal: h1 && h1.candidate ? { ...h1.candidate, status: h1.status, state: h1.state } : null,
    evaluationOrder: co.evaluationOrder,
  };
}

/**
 * Compact per-pair scan card (for the live/history multi-pair grid). Runs the
 * exact coordinator and summarizes the D1→H4→H1 stage without building charts.
 */
function buildScanCard(input) {
  const evalMs = snapToCompletedH1(input.at);
  const co = runCoordinator({ h1raw: input.h1raw, evalMs, pair: input.pair, spread: input.spread });
  const d1 = co.d1, h4 = co.h4, h1 = co.h1;
  const hasSignal = h1 && h1.candidate && (h1.state === H1_STATE.ENTRY_PENDING || h1.state === H1_STATE.ACTIVE);
  const signal = hasSignal ? { direction: h1.candidate.direction, entry: h1.candidate.entry, stop: h1.candidate.stop, target: h1.candidate.target, r: h1.candidate.r, entryType: h1.candidate.entryType, status: h1.status } : null;

  // Stage / ranking so qualifying pairs surface first.
  let stage = 'NEUTRAL', rank = 0;
  if (d1.direction !== D1_DIRECTION.NEUTRAL) { stage = 'D1_ALIGNED'; rank = 1; }
  if (h4.state === H4_STATE.IMPULSE_ACTIVE) { stage = 'H4_IMPULSE'; rank = 2; }
  if (h4.state === H4_STATE.PULLBACK_ACTIVE) { stage = 'H4_PULLBACK'; rank = 3; }
  if (signal) { stage = 'SIGNAL'; rank = h1.state === H1_STATE.ACTIVE ? 5 : 4; }

  return {
    pair: input.pair, evalMs, evalIso: new Date(evalMs).toISOString(), marketState: co.marketState,
    d1Direction: d1.direction, d1Protected: d1.protectedLevel,
    h4State: h4.state, h4Origin: h4.impulse ? h4.impulse.origin : null,
    h4PullbackAtr: h4.impulse ? +(h4.impulse.pullbackDepthAtr || 0).toFixed(2) : null, h4Age: h4.impulse ? h4.impulse.ageCandles : null,
    fridayCarry: !!(h4.impulse && h4.impulse.origin === ORIGIN.FRIDAY_CARRY),
    h1State: h1 ? h1.state : null, h1Status: h1 ? h1.status : null,
    stage, rank, qualifies: rank >= 3,
    signal,
    whyNoTrade: signal ? null : { code: h1 ? h1.rejection : 'NONE', text: rejectionText(h1 ? h1.rejection : 'NONE') },
  };
}

/** Monday session reopen (Sunday 17:00 NY) for the week following `ms`. */
function mondayReopenUtc(ms) {
  // walk forward to the next Sunday-17:00-NY session start
  let t = time.sessionStartUtc(ms);
  for (let i = 0; i < 10; i++) {
    t = time.sessionEndUtc(t);               // step to the next boundary
    if (time.isTradingSessionStart(t)) {
      // find the Monday-labelled session (Sunday start)
      const [, , dd] = time.sessionLabel(t).split('-').map(Number);
      const p = time.partsInTz(t, 'America/New_York');
      if (time.weekdayOfDate(p.year, p.month, p.day) === 0) return t; // Sunday start = Monday session
    }
  }
  return t;
}

module.exports = { buildHistoryView, buildScanCard, snapToCompletedH1, swingsAsOf, buildTimeline, mondayReopenUtc };
