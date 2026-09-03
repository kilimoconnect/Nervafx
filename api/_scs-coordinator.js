'use strict';

/**
 * SCS — Section 7b: strategy coordinator (pure, deterministic, paper/simulated only).
 *
 * At each completed H1 candle: (1) newly-completed D1 first, (2) H4 second,
 * (3) H1 third, (4) update strategy state, (5) return complete evaluation evidence.
 * Handles Friday cutoff, weekend freeze and Monday revalidation. Stateless: the
 * full state is recomputed from candles each call, so a restart reproduces it
 * exactly (restart recovery). No live orders — signals/paper/simulated only.
 */

const time = require('./_scs-time');
const { evaluateD1 } = require('./_scs-d1');
const { evaluateH4 } = require('./_scs-h4');
const { evaluateH1 } = require('./_scs-h1');
const { swingHighs, swingLows } = require('./_scs-indicators');
const risk = require('./_scs-risk');
const { D1_DIRECTION, H1_STATE, MARKET_STATE, SIGNAL_STATUS, REJECTION, CONFIG } = require('./_scs-config');

/** NORMAL / FRIDAY_CUTOFF / WEEKEND_FROZEN / MONDAY_REVALIDATION for an H1-close ms. */
function marketState(evalMs) {
  if (time.isWeekendClosed(evalMs)) return MARKET_STATE.WEEKEND_FROZEN;
  if (time.inFridayCutoff(evalMs)) return MARKET_STATE.FRIDAY_CUTOFF;
  const s = time.sessionStartUtc(evalMs - 1);
  const [cy, cm, cd] = time.sessionLabel(s).split('-').map(Number);
  const closeWd = time.weekdayOfDate(cy, cm, cd); // 1 = Monday close
  if (closeWd === 1 && evalMs === s + time.H1_MS) return MARKET_STATE.MONDAY_REVALIDATION;
  return MARKET_STATE.NORMAL;
}

/** Opposing confirmed D1/H4 swing prices for target-room (resistance for bull, support for bear). */
function opposingLevels(d1, h4candles, direction) {
  const bull = direction === D1_DIRECTION.BULLISH;
  const d1Sw = bull ? (d1.swingHighs || []) : (d1.swingLows || []);
  const h4Sw = bull ? swingHighs(h4candles) : swingLows(h4candles);
  return [...d1Sw, ...h4Sw].map((s) => s.price);
}

/**
 * Monday revalidation of a frozen setup against the Monday opening print.
 * Models opening-gap slippage: an active trade keeps its original stop/target but
 * a gap through them fills at the gapped open. A pending/frozen candidate whose
 * entry or stop was gapped past is invalidated (MONDAY_GAP_INVALIDATED).
 */
function revalidateMonday(frozen, mondayOpen) {
  if (!frozen || !frozen.candidate) return { ...frozen, revalidated: true };
  const c = frozen.candidate;
  const bull = c.direction === 'BUY';
  const out = { ...frozen, revalidated: true, mondayOpen, gap: null, slippage: 0 };
  if (frozen.state === H1_STATE.ACTIVE) {
    // active trade retains original stop & target; a gap through them fills at open
    if (bull ? mondayOpen >= c.target : mondayOpen <= c.target) { out.state = H1_STATE.COMPLETED; out.status = SIGNAL_STATUS.TARGET_HIT; out.fillPrice = mondayOpen; out.slippage = bull ? mondayOpen - c.target : c.target - mondayOpen; }
    else if (bull ? mondayOpen <= c.stop : mondayOpen >= c.stop) { out.state = H1_STATE.COMPLETED; out.status = SIGNAL_STATUS.STOP_HIT; out.fillPrice = mondayOpen; out.slippage = bull ? c.stop - mondayOpen : mondayOpen - c.stop; }
    return out;
  }
  // pending: a gap beyond entry (past it) or through the stop invalidates the setup
  const gappedPastEntry = bull ? mondayOpen < c.stop || mondayOpen > c.target : mondayOpen > c.stop || mondayOpen < c.target;
  if (gappedPastEntry) { out.state = H1_STATE.REJECTED; out.status = SIGNAL_STATUS.CANCELLED; out.rejection = REJECTION.MONDAY_GAP_INVALIDATED; }
  return out;
}

/**
 * Run one coordinator step.
 * input: { h1raw, evalMs, pair, spread?, normalSpread?, openPositions?, newsProvider?, riskPct?, config? }
 */
function runCoordinator(input) {
  const cfg = input.config || CONFIG;
  const evalMs = input.evalMs;
  const pair = input.pair || null;
  const ms = marketState(evalMs);

  // Same candle construction everywhere (live / history / backtest).
  const h1 = time.normalizeH1(input.h1raw, evalMs);
  const d1candles = time.assembleD1(h1, evalMs);
  const h4candles = time.assembleH4(h1, evalMs);

  // 1) D1 first, 2) H4 second.
  const d1 = evaluateD1(d1candles);
  const h4 = evaluateH4(h4candles, d1, evalMs);

  // Weekend: structure is still computed but no signal evaluation occurs.
  let h1res, admission = null;
  if (ms === MARKET_STATE.WEEKEND_FROZEN) {
    h1res = { triggered: false, state: H1_STATE.WAITING_BOS, status: SIGNAL_STATUS.FROZEN, rejection: REJECTION.WEEKEND_FROZEN, candidate: null, evidence: {}, bosConfirmed: false };
  } else {
    // 3) H1 third.
    const opposing = d1.direction === D1_DIRECTION.NEUTRAL ? [] : opposingLevels(d1, h4candles, d1.direction);
    h1res = evaluateH1(h1, d1, h4, evalMs, { spread: input.spread, opposingLevels: opposing, config: cfg });

    // Friday cutoff: no new entries; cancel unfilled pending; structure still stored.
    if (ms === MARKET_STATE.FRIDAY_CUTOFF && h1res.triggered && (h1res.state === H1_STATE.ENTRY_PENDING || h1res.status === SIGNAL_STATUS.PENDING)) {
      h1res = { ...h1res, state: H1_STATE.REJECTED, status: SIGNAL_STATUS.CANCELLED, rejection: REJECTION.FRIDAY_CUTOFF };
    }

    // Risk admission for a fresh, fillable candidate.
    if (h1res.triggered && h1res.rejection === REJECTION.NONE && (h1res.state === H1_STATE.ENTRY_PENDING || h1res.state === H1_STATE.ACTIVE)) {
      const nf = risk.makeNewsFilter(input.newsProvider);
      admission = risk.admit(h1res.candidate, {
        pair, direction: h1res.candidate.direction, openPositions: input.openPositions || [],
        spread: input.spread, normalSpread: input.normalSpread, riskPct: input.riskPct, newsFilter: nf, ms: evalMs,
      }, cfg);
      if (!admission.admit) h1res = { ...h1res, state: H1_STATE.REJECTED, status: SIGNAL_STATUS.REJECTED, rejection: admission.rejection };
    }
  }

  return {
    marketState: ms,
    evaluationOrder: time.EVAL_ORDER,       // ['D1','H4','H1']
    closes: time.closesAt(evalMs),
    d1, h4, h1: h1res, admission,
    evidence: { evalMs, evalIso: new Date(evalMs).toISOString(), pair, spread: input.spread, normalSpread: input.normalSpread, config: cfg.version },
  };
}

module.exports = { runCoordinator, marketState, opposingLevels, revalidateMonday };
