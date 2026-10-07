'use strict';

/**
 * M15 Research — interpretable state CLASSIFIER (Stage C, pure/deterministic).
 *
 * Composes the single-pair price-action descriptor (Stage A, research/m15/priceaction)
 * with the independent currency-strength network (Stage B, research/m15/strengthnet)
 * into an EXPLAINED state label for one pair, as-of a synchronized M15 close t. It
 * creates NO entry/exit rules and collapses nothing into an unexplained weighted
 * score — every state is produced by a transparent rule ladder over named evidence
 * codes, and the raw evidence is emitted alongside the label. Isolated from api/_m15.
 *
 * WINDOW ROLES (overlapping windows are NOT four independent votes):
 *   48h & 36h → established CONTEXT (counted together as ONE backdrop fact)
 *   24h       → TRANSITION (is a move underway?)
 *   latest-12h vs preceding-12h → PRESENT behaviour (momentum / acceleration)
 * The ONLY genuinely independent confirmation is the currency network's
 * leave-one-pair-out test (the other 27 pairs, with THIS pair excluded).
 *
 * Immutability: both sub-modules read only candles with close <= t, so a historical
 * output is fixed as of its candle close and never changes when later data arrives.
 */

const { describePriceAction } = require('./priceaction');
const { describeNetwork } = require('./strengthnet');

const CLASSIFIER_VERSION = 'm15-classifier-1.0.0';
const HOUR = 60 * 60 * 1000, M15 = 15 * 60 * 1000;

/**
 * Declared calibration. Boundaries are chosen from descriptor DISTRIBUTIONS and
 * label stability within the stated period — NEVER from trade profitability, and
 * NOT reverse-engineered from any chart/screenshot. Versioned so they can be refit.
 * (v1 are interpretable placeholders pending a formal distribution-fit pass.)
 */
const CALIBRATION = Object.freeze({
  version: 'cal-v1',
  effectivePeriod: { from: '2025-05-19', to: '2026-05-19' },
  basis: 'descriptor distribution & label-stability within the declared period; NOT trade profitability',
  thresholds: Object.freeze({
    ctxEff: 0.25,            // |efficiency| for 48h/36h to count as an established context
    transEnterEff: 0.30,     // |efficiency| (24h) to ENTER a directional/transition state
    transExitEff: 0.20,      // drop below this to leave it (hysteresis band)
    nowEff: 0.30,            // |efficiency| (latest 12h) for present directional behaviour
    accelMargin: 0.05,       // rise in |eff| present-vs-preceding ⇒ accelerating
    decelMargin: 0.10,       // fall in |eff| ⇒ exhaustion-risk (within an accepted trend)
    gapMin: 0.0003,          // |base−quote| strength gap to count as directional
    breadthMin: 0.60,        // fraction of the leading currency's pairs that must agree
    singleCandleDominance: 0.60, // one bar ≥ this share of the 12h path ⇒ single-candle driven
    illConditioned: 1e6,     // network condition number above which strength is flagged
  }),
});

const S = {
  BALANCED_RANGE: 'BALANCED_RANGE',
  EMERGING_MOVE_UP: 'EMERGING_MOVE_UP', EMERGING_MOVE_DOWN: 'EMERGING_MOVE_DOWN',
  ACCEPTED_TREND_UP: 'ACCEPTED_TREND_UP', ACCEPTED_TREND_DOWN: 'ACCEPTED_TREND_DOWN',
  ACCELERATING_TREND_UP: 'ACCELERATING_TREND_UP', ACCELERATING_TREND_DOWN: 'ACCELERATING_TREND_DOWN',
  EXHAUSTION_RISK_UP: 'EXHAUSTION_RISK_UP', EXHAUSTION_RISK_DOWN: 'EXHAUSTION_RISK_DOWN',
  REVERSAL_UP: 'REVERSAL_UP', REVERSAL_DOWN: 'REVERSAL_DOWN',
  CONFLICT: 'CONFLICT', UNAVAILABLE: 'UNAVAILABLE',
};

const dirLabel = (s) => (s > 0 ? 'UP' : s < 0 ? 'DOWN' : 'FLAT');
const toEat = (ms) => new Date(ms + 3 * HOUR).toISOString().replace('Z', '+03:00');

// ── price-action derived facts ─────────────────────────────────────────────────
function priceFacts(pa, pairCandles, t, th) {
  if (!pa.windows) return { ok: false };
  const w = pa.windows;
  const eff = (x) => (x && x.descriptors ? x.descriptors.directionalEfficiency : 0);
  const e48 = eff(w.h48), e36 = eff(w.h36), e24 = eff(w.h24);
  const latest = pa.comparison ? pa.comparison.latest12.directionalEfficiency : 0;
  const prev = pa.comparison ? pa.comparison.previous12.directionalEfficiency : 0;

  // Context = 48h & 36h TOGETHER (one fact). Directional only if both agree & strong.
  let ctxDir = 0, ctxMixed = false;
  if (Math.abs(e48) >= th.ctxEff && Math.abs(e36) >= th.ctxEff) {
    if (Math.sign(e48) === Math.sign(e36)) ctxDir = Math.sign(e48); else ctxMixed = true;
  }
  const transDir = Math.abs(e24) >= th.transEnterEff ? Math.sign(e24) : 0;
  const nowDir = Math.abs(latest) >= th.nowEff ? Math.sign(latest) : 0;
  const accel = Math.abs(latest) - Math.abs(prev);

  // Accepted holding event (balance departure accepted) + its side.
  let acceptedHoldDir = 0; let lastProvSide = 0;
  for (const ev of pa.balance ? pa.balance.events : []) {
    if (ev.type === 'DEPARTURE_PROVISIONAL') lastProvSide = /above/.test(ev.evidence) ? 1 : -1;
    if (ev.type === 'DEPARTURE_ACCEPTED') acceptedHoldDir = lastProvSide;
  }
  const rejection = (pa.balance ? pa.balance.events : []).some((e) => e.type === 'REJECTION' || e.type === 'RETURN');

  // Confirmed swings (known as-of t) + current provisional leg.
  const pivots = pa.swings ? pa.swings.pivots.filter((p) => p.confirmedAtMs <= t) : [];
  const lastPivot = pivots.length ? pivots[pivots.length - 1] : null;
  const provDir = pa.swings && pa.swings.provisional ? (pa.swings.provisional.direction === 'UP' ? 1 : pa.swings.provisional.direction === 'DOWN' ? -1 : 0) : 0;

  // Single-candle dominance over the latest 12h (strong 1-bar move ⇒ provisional only).
  const from = t - 12 * HOUR;
  const c12 = (pairCandles || []).filter((c) => c && c.complete !== false && c.openMs + M15 > from && c.openMs + M15 <= t).sort((a, b) => a.openMs - b.openMs);
  let path = 0, maxAbs = 0;
  for (let i = 1; i < c12.length; i++) { const d = Math.abs(c12[i].close - c12[i - 1].close); path += d; if (d > maxAbs) maxAbs = d; }
  const singleCandleDriven = path > 0 && (maxAbs / path) >= th.singleCandleDominance;

  return {
    ok: true, e48, e36, e24, latest, prev, ctxDir, ctxMixed, transDir, nowDir, accel,
    acceptedHoldDir, rejection, pivots, lastPivot, provDir, singleCandleDriven,
    paState: pa.state ? pa.state.label : null,
    counterMove24: w.h24 && w.h24.descriptors ? w.h24.descriptors.counterMove : 0,
  };
}

// ── strength (network) derived facts for THIS pair ─────────────────────────────
function strengthFacts(net, pair, th) {
  const base = pair.split('_')[0], quote = pair.split('_')[1];
  const h24 = net.windows ? net.windows.h24 : null;
  if (!h24 || !h24.available || !h24.gaps || h24.gaps[pair] == null) {
    return { available: false, reason: h24 ? (h24.reason || 'PAIR_MISSING_IN_NETWORK') : 'NO_NETWORK' };
  }
  const gap = h24.gaps[pair].baseMinusQuote;
  const strengthDir = Math.abs(gap) >= th.gapMin ? Math.sign(gap) : 0;
  const conf = net.leaveOnePairOut && net.leaveOnePairOut.confirmations ? net.leaveOnePairOut.confirmations[pair] : null;
  const independentlyConfirmed = !!(conf && conf.available && conf.independentlyConfirmed);
  const baseBreadth = h24.breadth && h24.breadth[base] ? h24.breadth[base].fraction : 0;
  const quoteBreadth = h24.breadth && h24.breadth[quote] ? h24.breadth[quote].fraction : 0;
  const leadingBreadth = strengthDir > 0 ? baseBreadth : strengthDir < 0 ? quoteBreadth : Math.max(baseBreadth, quoteBreadth);
  return {
    available: true, gap, strengthDir, independentlyConfirmed, baseBreadth, quoteBreadth, leadingBreadth,
    illConditioned: h24.diagnostics && h24.diagnostics.conditionNumber > th.illConditioned,
    leaveOutGap: conf && conf.available ? conf.leaveOut.baseMinusQuote : null,
  };
}

// ── the rule ladder (first match wins) ─────────────────────────────────────────
function decideState(pf, sf, th) {
  const forE = [], against = [];
  const add = (arr, code, text) => arr.push({ code, text });

  if (!pf.ok || pf.paState === 'NO_DATA' || pf.paState === 'INSUFFICIENT_DATA') {
    return { state: S.UNAVAILABLE, forE: [{ code: 'PA_UNAVAILABLE', text: 'insufficient price-action data at t' }], against };
  }

  // the move direction under consideration: transition first, else present
  const pDir = pf.transDir || pf.nowDir;
  const sDir = sf.available ? sf.strengthDir : 0;

  // context / present evidence (roles, not votes)
  if (pf.ctxDir) add(forE, pf.ctxDir > 0 ? 'CTX_UP' : 'CTX_DOWN', `48h+36h context ${dirLabel(pf.ctxDir)} (eff ${pf.e48}/${pf.e36})`);
  if (pf.ctxMixed) add(against, 'CTX_MIXED', '48h and 36h context disagree');
  if (pf.transDir) add(forE, pf.transDir > 0 ? 'TRANS_UP' : 'TRANS_DOWN', `24h transition ${dirLabel(pf.transDir)} (eff ${pf.e24})`);
  if (pf.nowDir) add(forE, pf.nowDir > 0 ? 'NOW_UP' : 'NOW_DOWN', `latest-12h ${dirLabel(pf.nowDir)} (eff ${pf.latest})`);
  if (pf.singleCandleDriven) add(against, 'SINGLE_CANDLE', 'present move dominated by one candle ⇒ provisional only');
  if (sf.available && sDir) add(forE, sDir > 0 ? 'STR_GAP_UP' : 'STR_GAP_DOWN', `strength gap ${dirLabel(sDir)} (base−quote ${sf.gap})`);
  if (sf.available && sf.independentlyConfirmed) add(forE, 'STR_CONFIRM', `independent currency confirmation (leave-one-out gap ${sf.leaveOutGap})`);
  if (!sf.available) add(against, 'STR_ABSENT', `no independent strength (${sf.reason})`);

  // CONFLICT — price and strength clearly disagree (strength independently confirmed opposite)
  if (pDir && sDir && pDir !== sDir && sf.independentlyConfirmed) {
    add(against, 'CONFLICT_PRICE_STRENGTH', `price ${dirLabel(pDir)} vs independently-confirmed strength ${dirLabel(sDir)}`);
    return { state: S.CONFLICT, forE, against, pDir, sDir };
  }

  // REVERSAL — a confirmed pivot opposing the established context, with present momentum that way
  if (pf.lastPivot && pf.nowDir) {
    const pivotNewDir = pf.lastPivot.type === 'LOW' ? 1 : -1;
    if (pivotNewDir === pf.nowDir && (pf.ctxDir === 0 ? Math.sign(pf.e48) : pf.ctxDir) === -pivotNewDir) {
      add(forE, pivotNewDir > 0 ? 'REVERSAL_UP' : 'REVERSAL_DOWN', `confirmed ${pf.lastPivot.type} pivot vs prior context, now ${dirLabel(pf.nowDir)}`);
      if (pf.rejection) add(forE, 'PRIOR_MOVE_REJECTED', 'prior move rejected (wick/return)');
      return { state: pivotNewDir > 0 ? S.REVERSAL_UP : S.REVERSAL_DOWN, forE, against, pDir: pivotNewDir, sDir };
    }
  }

  // ACCEPTED-trend gate (all three required)
  const sustained = pf.ctxDir !== 0 && pDir !== 0 && pf.ctxDir === pDir && Math.abs(pf.e24) >= th.transEnterEff && !pf.singleCandleDriven;
  const hold = pf.acceptedHoldDir === pDir || (pf.lastPivot && ((pf.lastPivot.type === 'LOW' && pDir > 0) || (pf.lastPivot.type === 'HIGH' && pDir < 0)));
  const indep = sf.available && sDir === pDir && sf.independentlyConfirmed && sf.leadingBreadth >= th.breadthMin;
  if (sustained && hold && indep) {
    add(forE, 'SUSTAINED_PROGRESS', 'context+transition agree, multi-window persistence (not independent votes)');
    add(forE, pDir > 0 ? 'ACCEPTED_HOLD_UP' : 'ACCEPTED_HOLD_DOWN', 'defensible holding/structure event in direction');
    add(forE, 'BROAD_INDEPENDENT_STRENGTH', `leading-currency breadth ${sf.leadingBreadth} ≥ ${th.breadthMin}, confirmed excluding this pair`);
    const up = pDir > 0;
    if (pf.accel > th.accelMargin && pf.nowDir === pDir) return { state: up ? S.ACCELERATING_TREND_UP : S.ACCELERATING_TREND_DOWN, forE, against, pDir, sDir };
    if (pf.accel < -th.decelMargin || pf.counterMove24 > 0 && pf.nowDir === -pDir) { add(against, 'DECELERATION', 'present momentum fading vs preceding 12h'); return { state: up ? S.EXHAUSTION_RISK_UP : S.EXHAUSTION_RISK_DOWN, forE, against, pDir, sDir }; }
    return { state: up ? S.ACCEPTED_TREND_UP : S.ACCEPTED_TREND_DOWN, forE, against, pDir, sDir };
  }

  // EMERGING — a move is underway but the accepted gate is not (yet) met
  if (pDir && (pf.nowDir === pDir || pf.transDir === pDir)) {
    if (!indep) add(against, 'NOT_INDEPENDENTLY_CONFIRMED', 'strength not broad/confirmed in this direction yet');
    if (!hold) add(against, 'NO_ACCEPTED_HOLD', 'no defensible holding/structure event yet');
    return { state: pDir > 0 ? S.EMERGING_MOVE_UP : S.EMERGING_MOVE_DOWN, forE, against, pDir, sDir };
  }

  add(forE, 'BALANCED', 'no directional transition; low net efficiency / high overlap');
  return { state: S.BALANCED_RANGE, forE, against, pDir: 0, sDir };
}

// ── hysteresis (avoid noisy label flipping) ────────────────────────────────────
function applyHysteresis(raw, pf, prevState, th) {
  // If we would drop to BALANCED but a directional backdrop is still weakly present
  // (|eff24| in the exit band) and the previous label was directional the same way,
  // hold an EMERGING label instead of flipping to balanced.
  if (raw.state === S.BALANCED_RANGE && prevState && /_(UP|DOWN)$/.test(prevState)) {
    const prevUp = /_UP$/.test(prevState), prevDown = /_DOWN$/.test(prevState);
    const e24 = pf.e24;
    if (prevUp && e24 > 0 && Math.abs(e24) >= th.transExitEff) return { state: S.EMERGING_MOVE_UP, hysteresis: true };
    if (prevDown && e24 < 0 && Math.abs(e24) >= th.transExitEff) return { state: S.EMERGING_MOVE_DOWN, hysteresis: true };
  }
  return { state: raw.state, hysteresis: false };
}

function transitionKind(from, to) {
  if (!from || from === to) return 'NONE';
  const acc = /ACCEPTED|ACCELERATING/;
  if (/EMERGING/.test(from) && acc.test(to)) return 'ACCEPTANCE';
  if (acc.test(from) && /EXHAUSTION/.test(to)) return 'EXHAUSTION_ONSET';
  if (/REVERSAL/.test(to)) return 'REVERSAL';
  if (to === S.CONFLICT) return 'CONFLICT_ONSET';
  if (acc.test(from) && /EMERGING|BALANCED/.test(to)) return 'BREAKDOWN';
  return 'CHANGE';
}

// ── public API ──────────────────────────────────────────────────────────────
/**
 * @param {string} pair canonical pair (e.g. 'EUR_GBP')
 * @param {Object} historiesByPair all-pair candle histories (for the network)
 * @param {Object} opts { asOfCloseMs:t (required), prevState?, calibration? }
 */
function classify(pair, historiesByPair, opts = {}) {
  const t = opts.asOfCloseMs;
  if (t == null) throw new Error('classify: asOfCloseMs (t) required');
  const cal = opts.calibration || CALIBRATION;
  const th = cal.thresholds;

  const pa = describePriceAction(historiesByPair[pair] || [], { pair, asOfCloseMs: t });
  const net = opts.network || describeNetwork(historiesByPair, { asOfCloseMs: t });
  const pf = priceFacts(pa, historiesByPair[pair] || [], t, th);
  const sf = strengthFacts(net, pair, th);

  const raw = decideState(pf, sf, th);
  const hz = applyHysteresis(raw, pf, opts.prevState, th);
  const primaryState = hz.state;

  // quality flags
  const flags = [];
  if (!sf.available) flags.push('STRENGTH_ABSENT');
  if (sf.available && sf.illConditioned) flags.push('NETWORK_ILL_CONDITIONED');
  if (pa.windows && pa.windows.h48 && pa.windows.h48.coveragePct < 100) flags.push('PRICE_COVERAGE_PARTIAL');
  if (net.windows && net.windows.h24 && net.windows.h24.coverage && net.windows.h24.coverage.pairsUsed < net.windows.h24.coverage.pairsExpected) flags.push('NETWORK_COVERAGE_PARTIAL');
  if (pa.integrity && pa.integrity.duplicates) flags.push('DUPLICATE_CANDLES');
  if (hz.hysteresis) flags.push('HYSTERESIS_HOLD');

  const win = pa.windows || {};
  const emit = {
    version: CLASSIFIER_VERSION, calibration: { version: cal.version, effectivePeriod: cal.effectivePeriod, basis: cal.basis },
    pair, asOfCloseUtc: new Date(t).toISOString(), asOfCloseEat: toEat(t), asOfCloseMs: t,
    primaryState, previousState: opts.prevState || null,
    transition: { from: opts.prevState || null, to: primaryState, changed: !!opts.prevState && opts.prevState !== primaryState, kind: transitionKind(opts.prevState, primaryState) },
    windows: {
      context_48_36h: { coveragePct48: win.h48 ? win.h48.coveragePct : null, eff48: pf.e48, eff36: pf.e36, direction: dirLabel(pf.ctxDir), mixed: pf.ctxMixed },
      transition_24h: { coveragePct: win.h24 ? win.h24.coveragePct : null, eff: pf.e24, direction: dirLabel(pf.transDir), gap: sf.available ? sf.gap : null, breadth: sf.available ? sf.leadingBreadth : null },
      present_12h: { latestEff: pf.latest, previousEff: pf.prev, direction: dirLabel(pf.nowDir), accel: +(+pf.accel).toFixed(4), singleCandleDriven: pf.singleCandleDriven },
    },
    structure: { acceptedHold: pf.acceptedHoldDir !== 0, acceptedHoldDir: dirLabel(pf.acceptedHoldDir), confirmedPivots: pf.pivots ? pf.pivots.length : 0, lastPivot: pf.lastPivot || null, provisionalLeg: pa.swings ? pa.swings.provisional : null, rejection: pf.rejection },
    progress: { contextDir: dirLabel(pf.ctxDir), transitionDir: dirLabel(pf.transDir), presentDir: dirLabel(pf.nowDir) },
    acceptance: { priceHold: pf.acceptedHoldDir !== 0, strengthIndependentlyConfirmed: sf.available ? sf.independentlyConfirmed : false, leadingBreadth: sf.available ? sf.leadingBreadth : null },
    strength: sf,
    evidenceFor: raw.forE, evidenceAgainst: raw.against,
    qualityFlags: flags,
    explanation: explain(primaryState, pf, sf, pair),
  };
  return emit;
}

// ── plain-English explanation ──────────────────────────────────────────────────
function explain(state, pf, sf, pair) {
  const [b, q] = pair.split('_');
  const strTxt = sf.available
    ? `Currency network: ${b}−${q} gap ${sf.gap} (${dirLabel(sf.strengthDir)})${sf.independentlyConfirmed ? ', independently confirmed excluding this pair' : ', NOT independently confirmed'} (leading breadth ${sf.leadingBreadth}).`
    : `Currency network strength is unavailable (${sf.reason}); acceptance cannot rely on independent confirmation.`;
  const ctx = `Context 48h/36h ${dirLabel(pf.ctxDir)}${pf.ctxMixed ? ' (mixed)' : ''}, 24h transition ${dirLabel(pf.transDir)}, latest-12h ${dirLabel(pf.nowDir)}.`;
  const head = {
    [S.UNAVAILABLE]: 'Not enough completed price data at this close to describe behaviour.',
    [S.BALANCED_RANGE]: 'Price is rotating in balance with no net directional progress.',
    [S.EMERGING_MOVE_UP]: 'An upward move is underway but has not met the acceptance bar (provisional).',
    [S.EMERGING_MOVE_DOWN]: 'A downward move is underway but has not met the acceptance bar (provisional).',
    [S.ACCEPTED_TREND_UP]: 'An uptrend is accepted: sustained progress, a defensible holding event, and broad independent strength.',
    [S.ACCEPTED_TREND_DOWN]: 'A downtrend is accepted: sustained lower prices held, with broad independent strength.',
    [S.ACCELERATING_TREND_UP]: 'An accepted uptrend is accelerating (present momentum rising).',
    [S.ACCELERATING_TREND_DOWN]: 'An accepted downtrend is accelerating (present momentum rising).',
    [S.EXHAUSTION_RISK_UP]: 'An accepted uptrend shows exhaustion RISK (momentum fading) — a risk description, not a countertrend signal.',
    [S.EXHAUSTION_RISK_DOWN]: 'An accepted downtrend shows exhaustion RISK (momentum fading) — a risk description, not a countertrend signal.',
    [S.REVERSAL_UP]: 'A confirmed low pivot has rejected the prior down context; price is turning up.',
    [S.REVERSAL_DOWN]: 'A confirmed high pivot has rejected the prior up context; price is turning down.',
    [S.CONFLICT]: 'Price direction and independently-confirmed currency strength disagree — treat as conflicted.',
  }[state] || state;
  return `${head} ${ctx} ${strTxt}`;
}

module.exports = { CLASSIFIER_VERSION, CALIBRATION, STATES: S, classify, priceFacts, strengthFacts, decideState, transitionKind };
