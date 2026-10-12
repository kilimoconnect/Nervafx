'use strict';

/**
 * Accepted balance break (up / down) — deterministic, versioned research pattern.
 *
 * This module does NOT build a second market-structure engine. It REUSES the causal
 * balance-zone + departure lifecycle already emitted by priceaction.balanceLifecycle
 * (BALANCE_FORMED → DEPARTURE_PROVISIONAL → DEPARTURE_ACCEPTED / RETURN …) and only
 * interprets those events, for the most-recent departure episode, into a single
 * pattern instance with state FORMING / CONFIRMED / INVALIDATED / UNAVAILABLE.
 *
 * Rules it honours (all inherited from the research definitions):
 *  - Completed M15 candles only (prepare() filters incomplete/future bars).
 *  - Past-only adaptive scale: the zone half-width tol = zoneTolK * median|Δclose| over
 *    the 48h window. Every size comparison reuses that scale — no EMA/RSI, no candlestick
 *    names, no fixed-pip thresholds.
 *  - Nothing is labelled before the candle whose close makes it knowable.
 *
 * The 12/24/36/48h price context and the other-pair currency-strength evidence are
 * attached as SEPARATE fields; a strength disagreement is surfaced, never discarded.
 * One episode is reported per call (overlapping re-detections dedupe to one patternId).
 */

const { describePriceAction, DEFAULTS, M15 } = require('./priceaction');

const PATTERN_VERSION = 'accepted-balance-break-1.0.0';
const HOUR = 60 * 60 * 1000;
const toUtc = (ms) => new Date(ms).toISOString();
const toEat = (ms) => new Date(ms + 3 * HOUR).toISOString().replace('Z', '+03:00');

function priceContext(pa) {
  const g = (w) => (w && w.descriptors) ? { coveragePct: w.coveragePct, efficiency: w.descriptors.directionalEfficiency, direction: w.descriptors.direction, range: w.descriptors.range, positionInRange: w.descriptors.positionInRange } : null;
  const W = pa.windows || {};
  return { h12: g(W.h12), h24: g(W.h24), h36: g(W.h36), h48: g(W.h48) };
}

// Other-pair currency strength for the break direction — kept visible even when it disagrees.
// Mapping (#5): for BASE_QUOTE, gap = strength(base) − strength(quote). gap>0 ⇒ base stronger ⇒
// price tends UP, so an UP break AGREES when gap>0 and a DOWN break AGREES when gap<0.
function strengthEvidence(pair, dir, network) {
  const out = { available: false, gap: null, strengthDir: null, agrees: null, otherPairConfirmed: null, disagreement: null };
  if (!pair || !network || !network.windows || !network.windows.h24 || !network.windows.h24.available) return out;
  const conf = network.leaveOnePairOut && network.leaveOnePairOut.confirmations && network.leaveOnePairOut.confirmations[pair];
  const gap = conf && conf.full ? conf.full.baseMinusQuote : null;
  if (gap == null) return out;
  const strengthDir = gap > 0 ? 'UP' : gap < 0 ? 'DOWN' : 'FLAT';
  out.available = true; out.gap = +gap.toFixed(8); out.strengthDir = strengthDir; out.otherPairConfirmed = !!(conf && conf.independentlyConfirmed);
  if (dir) {
    out.agrees = strengthDir === dir;
    if (!out.agrees && strengthDir !== 'FLAT') out.disagreement = `Price broke ${dir} but 24h other-pair strength favours ${strengthDir === 'UP' ? 'the base currency' : 'the quote currency'} (gap ${gap.toFixed(5)}).`;
  }
  return out;
}

const candleAtCloseMs = (cands, ms) => { for (let i = 0; i < cands.length; i++) if (cands[i].openMs + M15 === ms) return cands[i]; return null; };

/**
 * @param cands single-pair research candles (ascending, with .complete)
 * @param opts  { asOfCloseMs (required), pair, network }
 */
function detect(cands, opts = {}) {
  const pair = opts.pair || null;
  const network = opts.network || null;
  const pa = opts.pa || describePriceAction(cands, { pair, asOfCloseMs: opts.asOfCloseMs });   // reuse a precomputed PA when available
  const T = pa.asOfCloseMs;
  const thresh = { zoneTolK: DEFAULTS.zoneTolK, minTouches: DEFAULTS.minTouches, acceptN: DEFAULTS.acceptN, scale: 'median|Δclose| over 48h (past-only)', thresholdVersion: pa.thresholdVersion };
  const base = {
    version: PATTERN_VERSION, pair, asOfCloseMs: T, asOfCloseUtc: pa.asOfCloseUtc, asOfCloseEat: toEat(T),
    priceContext: priceContext(pa), calibration: thresh,
  };
  const unavailable = (reason) => ({ ...base, state: 'UNAVAILABLE', reason, direction: null, zone: null, departure: null, confirmation: null, invalidation: null, knowableAtMs: T, strength: strengthEvidence(pair, null, network), patternId: null, explanation: `Accepted balance break UNAVAILABLE — ${reason}.` });

  if (!pa.windows || pa.state.label === 'NO_DATA') return unavailable('NO_DATA');
  if (pa.state.label === 'INSUFFICIENT_DATA') return unavailable('INSUFFICIENT_DATA');
  if (!pa.balance || !pa.balance.zone) return unavailable('NO_ZONE');

  const zone = pa.balance.zone, C = pa.integrity.candles, acceptN = DEFAULTS.acceptN;
  const closeSet = new Set(C.map((c) => c.openMs + M15));
  // Reconstruct ALL departure episodes from the causal events (one per DEPARTURE_PROVISIONAL).
  const episodes = []; let curEp = null;
  for (const e of pa.balance.events) {
    if (e.type === 'DEPARTURE_PROVISIONAL') { curEp = { provisionalMs: e.ms, acceptedMs: null, acceptedKind: null, failedMs: null }; episodes.push(curEp); }
    else if (e.type === 'DEPARTURE_ACCEPTED' && curEp) { curEp.acceptedMs = e.ms; curEp.acceptedKind = /retest/i.test(e.evidence) ? 'retest' : 'consecutive'; }
    else if (e.type === 'RETURN' && curEp && !curEp.acceptedMs) curEp.failedMs = e.ms;
  }
  const ep = episodes[episodes.length - 1];
  if (!ep) return unavailable('NO_ACTIVE_BREAK');

  const dirOf = (ms) => { const c = candleAtCloseMs(C, ms); return c ? (c.close > zone.high ? 'UP' : c.close < zone.low ? 'DOWN' : null) : null; };
  const dir = dirOf(ep.provisionalMs);
  if (!dir) return unavailable('AMBIGUOUS_DIRECTION');

  // (#3) Anchor the structural reference to the breached edge of the zone AS OF the provisional
  // close, so the invalidation level does not drift as the adaptive 48h zone is recomputed.
  let anchoredEdge = dir === 'UP' ? zone.high : zone.low;
  if (ep.provisionalMs !== T) { try { const pp = describePriceAction(cands, { pair, asOfCloseMs: ep.provisionalMs }); if (pp.balance && pp.balance.zone) anchoredEdge = dir === 'UP' ? pp.balance.zone.high : pp.balance.zone.low; } catch (e) {} }
  const invRule = `Accepted reclaim: ${acceptN} consecutive completed closes back ${dir === 'UP' ? 'below' : 'above'} the breached edge ${anchoredEdge} (i.e. back inside the zone).`;
  const departure = { provisionalMs: ep.provisionalMs, provisionalUtc: toUtc(ep.provisionalMs), direction: dir };
  const staleBeforeClose = (pa.integrity.gaps || []).some((g) => g.toMs === T - M15);

  // (#2) Acceptance must be CONTIGUOUS — no data gap at the confirming candle. A 'retest'
  // acceptance counts only if its re-break follows a present candle; otherwise require acceptN
  // contiguous completed closes beyond the zone (which also recovers a hold after a gap).
  const firstContiguousBeyondMs = () => {
    let run = 0, prevMs = null, prevBeyond = false;
    for (const c of C) { const cm = c.openMs + M15, beyond = dir === 'UP' ? c.close > zone.high : c.close < zone.low;
      if (cm < ep.provisionalMs) { prevMs = cm; prevBeyond = beyond; continue; }
      if (beyond) { run = (prevBeyond && cm === prevMs + M15) ? run + 1 : 1; if (run >= acceptN) return cm; } else run = 0;
      prevMs = cm; prevBeyond = beyond; }
    return null;
  };
  let confMs = null, confKind = null;
  if (ep.acceptedMs) {
    if (ep.acceptedKind === 'retest' && closeSet.has(ep.acceptedMs - M15)) { confMs = ep.acceptedMs; confKind = 'retest'; }
    else { const cm = firstContiguousBeyondMs(); if (cm != null) { confMs = cm; confKind = 'consecutive'; } }
  }
  // (#1) Post-confirmation invalidation = acceptN consecutive completed closes back INSIDE the zone.
  const reclaimAfter = (ms) => { let run = 0; for (const c of C) { const cm = c.openMs + M15; if (cm <= ms) continue; if (c.close >= zone.low && c.close <= zone.high) { run++; if (run >= acceptN) return cm; } else run = 0; } return null; };

  let state, knowableAtMs, confirmation = null, invalidation, confirmationPending = null;
  if (ep.failedMs) {
    state = 'INVALIDATED'; knowableAtMs = ep.failedMs;
    invalidation = { price: anchoredEdge, rule: invRule, hitMs: ep.failedMs, hitUtc: toUtc(ep.failedMs), how: 'provisional break returned into balance before acceptance' };
  } else if (confMs != null) {
    const accCandle = candleAtCloseMs(C, confMs);
    confirmation = { ms: confMs, utc: toUtc(confMs), eat: toEat(confMs), price: accCandle ? accCandle.close : null, kind: confKind };
    const invMs = reclaimAfter(confMs);
    if (invMs) { state = 'INVALIDATED'; knowableAtMs = invMs; invalidation = { price: anchoredEdge, rule: invRule, hitMs: invMs, hitUtc: toUtc(invMs), how: `accepted break reclaimed — ${acceptN} consecutive closes back inside the zone` }; }
    else { state = 'CONFIRMED'; knowableAtMs = confMs; invalidation = { price: anchoredEdge, rule: invRule, hitMs: null }; }
  } else {
    state = 'FORMING'; knowableAtMs = ep.provisionalMs; invalidation = { price: anchoredEdge, rule: invRule, hitMs: null };
    if (ep.acceptedMs) confirmationPending = 'DATA_GAP';   // the lifecycle accepted across a gap; confirmation withheld
  }

  // (#4) descriptive swing context (NOT a gate on confirmation)
  const sw = pa.swings || {}; const lastPivot = sw.pivots && sw.pivots.length ? sw.pivots[sw.pivots.length - 1] : null;
  const swingContext = { lastConfirmedPivot: lastPivot ? { type: lastPivot.type, price: lastPivot.price, confirmedAtMs: lastPivot.confirmedAtMs } : null, provisionalLegDirection: sw.provisional ? sw.provisional.direction : null, supportsBreak: lastPivot ? (dir === 'UP' ? lastPivot.type === 'LOW' : lastPivot.type === 'HIGH') : null };
  // (#6) recent RESOLVED episodes before the current one (newest last, max 3)
  const recentEpisodes = episodes.slice(0, -1).filter((e) => e.acceptedMs || e.failedMs).slice(-3).map((e) => ({ provisionalMs: e.provisionalMs, direction: dirOf(e.provisionalMs), result: e.acceptedMs ? 'CONFIRMED' : 'INVALIDATED', atMs: e.acceptedMs || e.failedMs }));

  const strength = strengthEvidence(pair, dir, network);
  const expl = state === 'CONFIRMED'
    ? `Accepted balance break ${dir}: price left the zone [${zone.low}, ${zone.high}] and ${confirmation.kind === 'retest' ? 'retested the breached edge then closed beyond again' : 'held ' + acceptN + ' contiguous closes beyond'} — knowable at ${confirmation.utc}. Invalidation: ${invRule.toLowerCase()}`
    : state === 'FORMING'
      ? (confirmationPending === 'DATA_GAP'
        ? `Balance break ${dir} FORMING: a close beyond the zone [${zone.low}, ${zone.high}] at ${departure.provisionalUtc}, but acceptance would span a data gap — confirmation withheld until contiguous closes beyond.`
        : `Balance break ${dir} FORMING: first close beyond the zone [${zone.low}, ${zone.high}] at ${departure.provisionalUtc}; not yet accepted. Confirms on ${acceptN} contiguous closes beyond, or a held retest; fails on ${invRule.toLowerCase()}`)
      : `Balance break ${dir} INVALIDATED: ${invalidation.how} at ${invalidation.hitUtc}.`;

  return {
    ...base, state, direction: dir, zone, departure, confirmation, confirmationPending, invalidation, knowableAtMs,
    strength, swingContext, recentEpisodes,
    dataHealth: { eligible: pa.integrity.eligible, gaps: pa.integrity.gaps, staleBeforeClose },
    patternId: (pair || 'PAIR') + '@' + ep.provisionalMs, explanation: expl,
  };
}

/** Pattern at every eligible completed close in (fromMs, toMs] — for replay/outcome study. */
function patternSeries(cands, opts = {}) {
  const out = [];
  const elig = (cands || []).filter((c) => c && c.complete !== false).sort((a, b) => a.openMs - b.openMs);
  for (const c of elig) {
    const t = c.openMs + M15;
    if (opts.fromMs != null && t <= opts.fromMs) continue;
    if (opts.toMs != null && t > opts.toMs) break;
    out.push(detect(cands, { pair: opts.pair, network: opts.network, asOfCloseMs: t }));
  }
  return out;
}

module.exports = { PATTERN_VERSION, detect, patternSeries, priceContext, strengthEvidence };
