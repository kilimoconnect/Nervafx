'use strict';

/**
 * Failed balance break (up / down attempt) — deterministic, versioned research pattern.
 *
 * Describes an attempted departure from the balance area that LOSES acceptance: price
 * closed beyond the zone, then was reclaimed back inside and held there. It is NOT a
 * reversal signal and asserts nothing about a profitable opposite-side trade.
 *
 * Built ON TOP of balanceBreak.detect (shared versioned schema, same zone/episode/anchored
 * edge), so the accepted-break and failed-break labels can never claim contradictory current
 * states — a failure confirms exactly when the accepted break is reclaimed, and the
 * transition is reported. Completed M15 candles only; past-only adaptive scale (the zone tol);
 * no EMA/RSI/candlestick-names/fixed-pips. 12/24/36/48h context + other-pair strength attached.
 *
 * A "meaningful failure" (not a routine retest) requires the re-entry to be ACCEPTED back
 * inside: acceptN (2) CONTIGUOUS completed closes inside the zone after the departure (or after
 * its acceptance). Confirmation is stamped on that reclaim candle — never backdated to the
 * first candle outside the area. A wick-only penetration never starts an attempt (no close
 * beyond ⇒ no departure).
 */

const { describePriceAction, DEFAULTS, M15 } = require('./priceaction');
const balanceBreak = require('./balanceBreak');

const PATTERN_VERSION = 'failed-balance-break-1.0.0';
const HOUR = 60 * 60 * 1000;
const toUtc = (ms) => new Date(ms).toISOString();
const toEat = (ms) => new Date(ms + 3 * HOUR).toISOString().replace('Z', '+03:00');

// first candle-close > afterMs whose candle satisfies pred
function firstMatchAfter(C, pred, afterMs) { for (const c of C) { const cm = c.openMs + M15; if (cm <= afterMs) continue; if (pred(c)) return cm; } return null; }
// end-close of the first run of N CONTIGUOUS candles (in time) satisfying pred, counting only cm > afterMs
function firstRunEnd(C, pred, N, afterMs) {
  let run = 0, prevMs = null, prevOk = false;
  for (const c of C) { const cm = c.openMs + M15, ok = pred(c);
    if (cm <= afterMs) { prevMs = cm; prevOk = ok; continue; }
    if (ok) { run = (prevOk && cm === prevMs + M15) ? run + 1 : 1; if (run >= N) return cm; } else run = 0;
    prevMs = cm; prevOk = ok; }
  return null;
}

function detect(cands, opts = {}) {
  const pair = opts.pair || null;
  const network = opts.network || null;
  const pa = opts.pa || describePriceAction(cands, { pair, asOfCloseMs: opts.asOfCloseMs });
  const ab = opts.ab || balanceBreak.detect(cands, { pair, asOfCloseMs: opts.asOfCloseMs, network, pa });   // reuse the accepted-break if already computed
  const T = pa.asOfCloseMs, acceptN = DEFAULTS.acceptN;

  const base = {
    version: PATTERN_VERSION, pair, asOfCloseMs: T, asOfCloseUtc: pa.asOfCloseUtc, asOfCloseEat: toEat(T),
    priceContext: ab.priceContext, calibration: { acceptN, scale: 'median|Δclose| over 48h (past-only)', thresholdVersion: pa.thresholdVersion },
  };
  const unavailable = (reason) => ({ ...base, state: 'UNAVAILABLE', reason, direction: null, zone: ab.zone || null, attempt: null, confirmation: null, invalidation: null, transition: null, knowableAtMs: T, strength: ab.strength, patternId: null, explanation: `Failed balance break UNAVAILABLE — ${reason}.` });

  if (ab.state === 'UNAVAILABLE') return unavailable(ab.reason === 'NO_ACTIVE_BREAK' ? 'NO_ATTEMPT' : ab.reason);

  const dir = ab.direction, zone = ab.zone, C = pa.integrity.candles;
  const provisionalMs = ab.departure.provisionalMs;
  const accMs = ab.confirmation ? ab.confirmation.ms : null;          // the departure's acceptance close (or null)
  const anchorMs = accMs != null ? accMs : provisionalMs;
  const edge = ab.invalidation.price;                                 // anchored breached edge (from the accepted-break)
  const inside = (c) => c.close >= zone.low && c.close <= zone.high;
  const beyond = (c) => dir === 'UP' ? c.close > zone.high : c.close < zone.low;

  const reclaimMs = firstRunEnd(C, inside, acceptN, anchorMs);        // 2 contiguous closes back inside after the departure/acceptance
  const firstReentryMs = firstMatchAfter(C, inside, anchorMs);       // first single close back inside
  const staleBeforeClose = (pa.integrity.gaps || []).some((g) => g.toMs === T - M15);
  const attempt = { provisionalMs, provisionalUtc: toUtc(provisionalMs), direction: dir, wasAccepted: accMs != null, acceptedMs: accMs };
  const invRule = `A fresh accepted break beyond the edge ${edge} (${acceptN} contiguous completed closes beyond again).`;
  const dataHealth = { eligible: pa.integrity.eligible, gaps: pa.integrity.gaps, staleBeforeClose };

  let state, knowableAtMs, confirmation = null, invalidation, transition = null, confirmationPending = null, reason = null;

  if (reclaimMs != null) {
    // a fresh accepted break AFTER the reclaim overtakes the failure
    const reDepartMs = firstRunEnd(C, beyond, acceptN, reclaimMs);
    const failureType = accMs != null ? 'acceptance-reclaimed' : 'departure-rejected';
    transition = accMs != null
      ? { from: 'ACCEPTED_BREAK_CONFIRMED', to: 'FAILED_BREAK', acceptedConfirmationMs: accMs, note: 'An accepted break was reclaimed — it now reads as a failed break.' }
      : { from: 'ATTEMPTED_DEPARTURE', to: 'FAILED_BREAK', note: 'A departure never gained acceptance and was reclaimed back inside.' };
    if (reDepartMs != null) {
      state = 'INVALIDATED'; knowableAtMs = reDepartMs;
      invalidation = { price: edge, rule: invRule, hitMs: reDepartMs, hitUtc: toUtc(reDepartMs), how: 'failure overtaken — a fresh accepted break beyond the edge' };
    } else {
      state = 'CONFIRMED'; knowableAtMs = reclaimMs; reason = failureType;
      const accCandle = C.find((c) => c.openMs + M15 === reclaimMs);
      confirmation = { ms: reclaimMs, utc: toUtc(reclaimMs), eat: toEat(reclaimMs), price: accCandle ? accCandle.close : null, failureType };
      invalidation = { price: edge, rule: invRule, hitMs: null };
    }
  } else if (firstReentryMs != null) {
    state = 'FORMING'; knowableAtMs = firstReentryMs;                  // re-entering, not yet an accepted (sustained) failure
    invalidation = { price: edge, rule: invRule, hitMs: null };
    if (staleBeforeClose) confirmationPending = 'DATA_GAP';
  } else {
    // price is still holding beyond the zone — no failure yet
    return unavailable(accMs != null ? 'NO_FAILURE' : 'NO_FAILURE_YET');
  }

  const strength = ab.strength;   // other-pair currency strength for the ORIGINAL break direction (kept visible, incl. disagreement)
  const expl = state === 'CONFIRMED'
    ? `Failed balance break: a ${dir} ${reason === 'acceptance-reclaimed' ? 'accepted break' : 'departure'} from the zone [${zone.low}, ${zone.high}] lost acceptance — ${acceptN} contiguous closes back inside — knowable at ${confirmation.utc}. This is a loss of the breakout, not a reversal signal. Invalidated by ${invRule.toLowerCase()}`
    : state === 'FORMING'
      ? `Failed break FORMING: the ${dir} ${accMs != null ? 'accepted break' : 'departure'} has re-entered the zone at ${toUtc(firstReentryMs)}; needs ${acceptN} contiguous closes inside to confirm a meaningful failure (a single close is a routine retest).`
      : `Failed break INVALIDATED: ${invalidation.how} at ${invalidation.hitUtc}.`;

  return {
    ...base, state, direction: dir, zone, attempt, confirmation, confirmationPending, invalidation, transition,
    knowableAtMs, strength, swingContext: ab.swingContext || null, dataHealth,
    patternId: (pair || 'PAIR') + '@failed@' + provisionalMs, explanation: expl,
  };
}

function patternSeries(cands, opts = {}) {
  const out = [];
  const elig = (cands || []).filter((c) => c && c.complete !== false).sort((a, b) => a.openMs - b.openMs);
  for (const c of elig) { const t = c.openMs + M15; if (opts.fromMs != null && t <= opts.fromMs) continue; if (opts.toMs != null && t > opts.toMs) break; out.push(detect(cands, { pair: opts.pair, network: opts.network, asOfCloseMs: t })); }
  return out;
}

module.exports = { PATTERN_VERSION, detect, patternSeries };
