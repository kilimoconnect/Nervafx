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

  const zone = pa.balance.zone, C = pa.integrity.candles;
  // Reconstruct the CURRENT departure episode from the causal events only.
  let ep = null;
  for (const e of pa.balance.events) {
    if (e.type === 'DEPARTURE_PROVISIONAL') ep = { provisionalMs: e.ms, acceptedMs: null, acceptedKind: null, failedMs: null };
    else if (e.type === 'DEPARTURE_ACCEPTED' && ep) { ep.acceptedMs = e.ms; ep.acceptedKind = /retest/i.test(e.evidence) ? 'retest' : 'consecutive'; }
    else if (e.type === 'RETURN' && ep && !ep.acceptedMs) ep.failedMs = e.ms;
  }
  if (!ep) return unavailable('NO_ACTIVE_BREAK');

  const provCandle = candleAtCloseMs(C, ep.provisionalMs);
  const dir = provCandle ? (provCandle.close > zone.high ? 'UP' : provCandle.close < zone.low ? 'DOWN' : null) : null;
  if (!dir) return unavailable('AMBIGUOUS_DIRECTION');
  const breachedEdge = dir === 'UP' ? zone.high : zone.low;
  const invRule = `A completed M15 close back inside the balance zone (reclaiming the breached ${dir === 'UP' ? 'upper' : 'lower'} edge ${breachedEdge}).`;
  const departure = { provisionalMs: ep.provisionalMs, provisionalUtc: toUtc(ep.provisionalMs), direction: dir };
  const staleBeforeClose = (pa.integrity.gaps || []).some((g) => g.toMs === T - M15);

  let state, knowableAtMs, confirmation = null, invalidation;
  if (ep.failedMs) {
    state = 'INVALIDATED'; knowableAtMs = ep.failedMs;
    invalidation = { price: breachedEdge, rule: invRule, hitMs: ep.failedMs, hitUtc: toUtc(ep.failedMs), how: 'provisional break returned into balance before acceptance' };
  } else if (ep.acceptedMs) {
    const accCandle = candleAtCloseMs(C, ep.acceptedMs);
    confirmation = { ms: ep.acceptedMs, utc: toUtc(ep.acceptedMs), eat: toEat(ep.acceptedMs), price: accCandle ? accCandle.close : null, kind: ep.acceptedKind };
    // post-confirmation structural invalidation: first completed close back inside the zone AFTER acceptance
    let invMs = null;
    for (const c of C) { const cm = c.openMs + M15; if (cm <= ep.acceptedMs) continue; if (c.close >= zone.low && c.close <= zone.high) { invMs = cm; break; } }
    if (invMs) { state = 'INVALIDATED'; knowableAtMs = invMs; invalidation = { price: breachedEdge, rule: invRule, hitMs: invMs, hitUtc: toUtc(invMs), how: 'accepted break reclaimed — close back inside the zone' }; }
    else { state = 'CONFIRMED'; knowableAtMs = ep.acceptedMs; invalidation = { price: breachedEdge, rule: invRule, hitMs: null }; }
  } else {
    state = 'FORMING'; knowableAtMs = ep.provisionalMs; invalidation = { price: breachedEdge, rule: invRule, hitMs: null };
  }

  const strength = strengthEvidence(pair, dir, network);
  const expl = state === 'CONFIRMED'
    ? `Accepted balance break ${dir}: price left the zone [${zone.low}, ${zone.high}] and ${confirmation.kind === 'retest' ? 'retested the breached edge then closed beyond again' : 'closed beyond for consecutive M15 candles'} — knowable at ${confirmation.utc}. ${invRule}`
    : state === 'FORMING'
      ? `Balance break ${dir} FORMING: first close beyond the zone [${zone.low}, ${zone.high}] at ${departure.provisionalUtc}; not yet accepted. Confirms on acceptance (consecutive closes beyond, or a held retest); fails if ${invRule.toLowerCase()}`
      : `Balance break ${dir} INVALIDATED: ${invalidation.how} at ${invalidation.hitUtc}.`;

  return {
    ...base, state, direction: dir, zone, departure, confirmation, invalidation, knowableAtMs,
    strength, dataHealth: { eligible: pa.integrity.eligible, gaps: pa.integrity.gaps, staleBeforeClose },
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
