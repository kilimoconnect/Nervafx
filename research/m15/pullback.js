'use strict';

/**
 * Trend pullback continuation (up / down) — deterministic, versioned research pattern.
 *
 * REUSES the existing causal swing pivots (priceaction.detectSwings) for trend structure —
 * it does NOT re-implement structure and does NOT duplicate the classifier. Completed M15
 * candles only; past-only adaptive scale (pivot theta = k * median|Δclose|). No EMA/RSI/
 * candlestick-names/fixed-pips.
 *
 * Definition (UP; DOWN is symmetric):
 *  - Accepted directional structure: the last two CONFIRMED pivots are a LOW then a higher
 *    HIGH (a confirmed up impulse leg L → H). The pullback is the move after H.
 *  - Structural level it must hold: the prior swing LOW L (the higher-low reference).
 *  - Resumed progress that confirms continuation: acceptN (2) CONTIGUOUS completed closes
 *    beyond the prior swing extreme H (a held new high) — one close is a false resumption.
 *  - Broken trend: a completed close beyond the structural level L (below it) before continuation.
 *
 * The pullback extreme (lowest close since H) is reported as PROVISIONAL — it is never
 * labelled as a confirmed swing pivot using later information. Confirmation is stamped on the
 * candle whose close first completes the 2-close resumption, never backdated.
 */

const { describePriceAction, DEFAULTS, M15 } = require('./priceaction');
const { priceContext, strengthEvidence } = require('./balanceBreak');

const PATTERN_VERSION = 'trend-pullback-continuation-1.0.0';
const HOUR = 60 * 60 * 1000;
const toUtc = (ms) => new Date(ms).toISOString();
const toEat = (ms) => new Date(ms + 3 * HOUR).toISOString().replace('Z', '+03:00');

function firstRunEnd(C, pred, N, afterMs) {
  let run = 0, prevMs = null, prevOk = false;
  for (const c of C) { const cm = c.openMs + M15, ok = pred(c);
    if (cm <= afterMs) { prevMs = cm; prevOk = ok; continue; }
    if (ok) { run = (prevOk && cm === prevMs + M15) ? run + 1 : 1; if (run >= N) return cm; } else run = 0;
    prevMs = cm; prevOk = ok; }
  return null;
}
const firstMatchAfter = (C, pred, afterMs) => { for (const c of C) { const cm = c.openMs + M15; if (cm <= afterMs) continue; if (pred(c)) return cm; } return null; };
const candleAtCloseMs = (C, ms) => { for (const c of C) if (c.openMs + M15 === ms) return c; return null; };

function detect(cands, opts = {}) {
  const pair = opts.pair || null, network = opts.network || null;
  const pa = opts.pa || describePriceAction(cands, { pair, asOfCloseMs: opts.asOfCloseMs });
  const T = pa.asOfCloseMs, acceptN = DEFAULTS.acceptN;
  const base = {
    version: PATTERN_VERSION, pair, asOfCloseMs: T, asOfCloseUtc: pa.asOfCloseUtc, asOfCloseEat: toEat(T),
    priceContext: priceContext(pa), calibration: { acceptN, k: DEFAULTS.k, scale: 'pivot theta = k·median|Δclose| (past-only)', thresholdVersion: pa.thresholdVersion },
  };
  const unavailable = (reason) => ({ ...base, state: 'UNAVAILABLE', reason, direction: null, structure: null, pullback: null, confirmation: null, invalidation: null, knowableAtMs: T, strength: strengthEvidence(pair, null, network), evidenceFor: [], evidenceAgainst: [], patternId: null, explanation: `Trend pullback continuation UNAVAILABLE — ${reason}.` });

  if (!pa.windows || pa.state.label === 'NO_DATA') return unavailable('NO_DATA');
  if (pa.state.label === 'INSUFFICIENT_DATA') return unavailable('INSUFFICIENT_DATA');
  const piv = pa.swings && pa.swings.pivots ? pa.swings.pivots : [];
  const highs = piv.filter((p) => p.type === 'HIGH'), lows = piv.filter((p) => p.type === 'LOW');
  // Accepted directional structure = higher-high (up) / lower-low (down); robust to the
  // pullback extreme confirming as a new pivot mid-resumption.
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const ll = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
  let dir = null;
  if (hh && !ll && lows.length >= 1) dir = 'UP';
  else if (ll && !hh && highs.length >= 1) dir = 'DOWN';
  else return unavailable('NO_TREND');

  const extremePivot = dir === 'UP' ? highs[highs.length - 1] : lows[lows.length - 1];   // extreme to beat (resumption)
  const levelPivot = dir === 'UP' ? lows[lows.length - 1] : highs[highs.length - 1];     // structural level to hold
  const extreme = extremePivot.price, level = levelPivot.price;
  if (dir === 'UP' ? !(extreme > level) : !(extreme < level)) return unavailable('NO_TREND');
  const H = dir === 'UP' ? extremePivot : levelPivot, L = dir === 'UP' ? levelPivot : extremePivot;
  const afterMs = extremePivot.pivotTimeMs;             // pullback begins after the latest trend extreme
  const structureKnownMs = Math.max(extremePivot.confirmedAtMs, levelPivot.confirmedAtMs);
  const C = pa.integrity.candles;

  const beyondExtreme = (c) => dir === 'UP' ? c.close > extreme : c.close < extreme;
  const breaksLevel = (c) => dir === 'UP' ? c.close < level : c.close > level;
  const breakMs = firstMatchAfter(C, breaksLevel, afterMs);          // single close beyond the structural level
  const contMs = firstRunEnd(C, beyondExtreme, acceptN, afterMs);    // 2 contiguous closes beyond the extreme

  // provisional pullback extreme (counter-trend running extreme since the swing) — NOT a confirmed pivot
  let pbPrice = null, pbMs = null;
  for (const c of C) { const cm = c.openMs + M15; if (cm <= afterMs) continue; const v = c.close; if (pbPrice == null || (dir === 'UP' ? v < pbPrice : v > pbPrice)) { pbPrice = v; pbMs = cm; } }
  const impulseCandles = Math.max(1, Math.round((H.pivotTimeMs - L.pivotTimeMs) / M15 * (dir === 'UP' ? 1 : 1)) || 1);
  const pullbackCandles = Math.max(0, Math.round((T - afterMs) / M15));
  const stalled = pullbackCandles > Math.max(8, 2 * Math.abs(impulseCandles));
  const staleBeforeClose = (pa.integrity.gaps || []).some((g) => g.toMs === T - M15);
  const structure = { direction: dir, swingExtreme: { price: extreme, timeMs: dir === 'UP' ? H.pivotTimeMs : L.pivotTimeMs }, structuralLevel: { price: level, timeMs: dir === 'UP' ? L.pivotTimeMs : H.pivotTimeMs }, knownSinceMs: structureKnownMs };
  const pullback = { extremePrice: pbPrice, extremeMs: pbMs, confirmed: false, note: 'provisional — the pullback extreme is only a confirmed swing pivot once price resumes by theta' };
  const invRule = `A completed close ${dir === 'UP' ? 'below' : 'above'} the prior ${dir === 'UP' ? 'higher-low' : 'lower-high'} structural level ${level}.`;

  let state, knowableAtMs, confirmation = null, invalidation;
  const evidenceFor = [], evidenceAgainst = [];
  evidenceFor.push(`Accepted ${dir} structure: confirmed ${dir === 'UP' ? 'low → higher high' : 'high → lower low'} leg (${level} → ${extreme}).`);

  if (breakMs != null && (contMs == null || breakMs <= contMs)) {
    state = 'INVALIDATED'; knowableAtMs = breakMs;
    invalidation = { price: level, rule: invRule, hitMs: breakMs, hitUtc: toUtc(breakMs), how: `pullback broke the structural level ${level} (trend structure broken)` };
    evidenceAgainst.push(`Close beyond the structural level ${level} — the higher-${dir === 'UP' ? 'low' : 'high'} is broken.`);
  } else if (contMs != null) {
    const cC = candleAtCloseMs(C, contMs);
    state = 'CONFIRMED'; knowableAtMs = contMs;
    confirmation = { ms: contMs, utc: toUtc(contMs), eat: toEat(contMs), price: cC ? cC.close : null, kind: `${acceptN} contiguous closes beyond ${extreme}` };
    invalidation = { price: level, rule: invRule, hitMs: null };
    evidenceFor.push(`Resumed: ${acceptN} contiguous closes beyond the prior extreme ${extreme}.`);
    evidenceFor.push(`Pullback held the structural level ${level} (provisional extreme ${pbPrice}).`);
  } else {
    state = 'FORMING'; knowableAtMs = structureKnownMs;
    invalidation = { price: level, rule: invRule, hitMs: null };
    evidenceFor.push(`Pullback holding above the structural level ${level} (provisional extreme ${pbPrice}).`);
    if (stalled) evidenceAgainst.push(`Prolonged pause: ${pullbackCandles} candles without resuming (> impulse ${impulseCandles}) — momentum unclear.`);
  }

  const strength = strengthEvidence(pair, dir, network);
  if (strength.disagreement) evidenceAgainst.push(strength.disagreement);
  else if (strength.agrees === true) evidenceFor.push('Other-pair currency strength agrees with the trend direction.');

  const expl = state === 'CONFIRMED'
    ? `Trend pullback continuation ${dir}: an accepted ${dir} leg pulled back, held the structural level ${level}, and resumed with ${acceptN} contiguous closes beyond ${extreme} — knowable at ${confirmation.utc}. Invalidation: ${invRule.toLowerCase()}`
    : state === 'FORMING'
      ? `Normal ${dir} pullback FORMING: accepted ${dir} leg (${level} → ${extreme}), price retracing but holding ${level}${stalled ? ' (prolonged pause — momentum unclear)' : ''}. Confirms on ${acceptN} contiguous closes beyond ${extreme}; breaks on ${invRule.toLowerCase()}`
      : `Trend BROKEN (${dir} pullback failed): ${invalidation.how} at ${invalidation.hitUtc}.`;

  return {
    ...base, state, direction: dir, structure, pullback, confirmation, invalidation, knowableAtMs,
    stalled, strength, swingContext: { lastConfirmedPivot: { type: piv[piv.length - 1].type, price: piv[piv.length - 1].price, confirmedAtMs: piv[piv.length - 1].confirmedAtMs } },
    evidenceFor, evidenceAgainst, dataHealth: { eligible: pa.integrity.eligible, gaps: pa.integrity.gaps, staleBeforeClose },
    patternId: (pair || 'PAIR') + '@pullback@' + (dir === 'UP' ? H : L).confirmedAtMs, explanation: expl,
  };
}

function patternSeries(cands, opts = {}) {
  const out = []; const elig = (cands || []).filter((c) => c && c.complete !== false).sort((a, b) => a.openMs - b.openMs);
  for (const c of elig) { const t = c.openMs + M15; if (opts.fromMs != null && t <= opts.fromMs) continue; if (opts.toMs != null && t > opts.toMs) break; out.push(detect(cands, { pair: opts.pair, network: opts.network, asOfCloseMs: t })); }
  return out;
}

module.exports = { PATTERN_VERSION, detect, patternSeries };
