'use strict';

/**
 * Shared frame/payload builder for the manual-decision workspace.
 *
 * Pure (no DB, no I/O): turns synchronized 28-pair M15 histories into the workspace
 * payload (meta, modelHealth, watchlist[{pair,candles,frames}]). Used by BOTH the
 * offline fixture engine (SYNTHETIC) and the live API (api/m15-workspace, REAL data),
 * so the two produce the identical contract. Every frame is immutable as-of its close.
 */

const { classify, CLASSIFIER_VERSION, CALIBRATION } = require('./classifier');
const { describeNetwork } = require('./strengthnet');
const { describePriceAction } = require('./priceaction');
const { syncAsOf, PAIRS } = require('./loader');

const M15 = 15 * 60 * 1000;

/** Forex market closed: Fri 21:00 UTC → Sun 21:00 UTC. */
function closedMarket(ms) { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); if (day === 6) return true; if (day === 0 && h < 21) return true; if (day === 5 && h >= 21) return true; return false; }

function nextConditionFor(state, structure) {
  const ref = structure.provisionalLeg ? structure.provisionalLeg.extremePrice : (structure.lastPivot ? structure.lastPivot.price : null);
  const map = {
    EMERGING_MOVE_UP: { next: 'Acceptance: a held break above balance + broad other-pair strength confirming up.', inval: 'Close back below the balance zone / a confirmed lower high.' },
    EMERGING_MOVE_DOWN: { next: 'Acceptance: a held break below balance + broad other-pair strength confirming down.', inval: 'Close back above the balance zone / a confirmed higher low.' },
    ACCEPTED_TREND_UP: { next: 'Continuation hold or acceleration of present 12h momentum.', inval: 'Confirmed high pivot against context or loss of other-pair strength confirmation.' },
    ACCEPTED_TREND_DOWN: { next: 'Continuation hold or acceleration of present 12h momentum.', inval: 'Confirmed low pivot against context or loss of other-pair strength confirmation.' },
    ACCELERATING_TREND_UP: { next: 'Momentum sustained; watch for deceleration (exhaustion risk).', inval: 'Confirmed high pivot / strength no longer confirmed.' },
    ACCELERATING_TREND_DOWN: { next: 'Momentum sustained; watch for deceleration (exhaustion risk).', inval: 'Confirmed low pivot / strength no longer confirmed.' },
    EXHAUSTION_RISK_UP: { next: 'Either momentum re-accelerates or a confirmed high pivot forms.', inval: 'Re-acceleration invalidates the exhaustion read.' },
    EXHAUSTION_RISK_DOWN: { next: 'Either momentum re-accelerates or a confirmed low pivot forms.', inval: 'Re-acceleration invalidates the exhaustion read.' },
    REVERSAL_UP: { next: 'New-direction acceptance (held higher prices + strength turning up).', inval: 'Failure to hold above the confirmed low / return under it.' },
    REVERSAL_DOWN: { next: 'New-direction acceptance (held lower prices + strength turning down).', inval: 'Failure to hold below the confirmed high / return over it.' },
    CONFLICT: { next: 'Price and other-pair strength must realign before any read is actionable.', inval: 'Either side flips to agree.' },
    BALANCED_RANGE: { next: 'A held break of the balance zone with strength support.', inval: 'Continued rotation inside the range.' },
    UNAVAILABLE: { next: 'Sufficient, synchronized, fresh data at the close.', inval: null },
  };
  const m = map[state] || { next: '—', inval: null };
  return { nextCondition: m.next, invalidationReference: m.inval, invalidationLevel: ref };
}

function extendedMoveFlag(pa) {
  const h48 = pa.windows && pa.windows.h48 && pa.windows.h48.descriptors;
  const h24 = pa.windows && pa.windows.h24 && pa.windows.h24.descriptors;
  if (!h48 || !h24) return false;
  return Math.abs(h48.directionalEfficiency) >= 0.7 && Math.abs(h24.directionalEfficiency) >= 0.6 && h48.actual >= 160;
}

/** Build one immutable frame for `pair` as-of close `t`. `net` may be precomputed. */
function buildFrame(pair, H, t, prev, candleIdx, net) {
  net = net || describeNetwork(H, { asOfCloseMs: t });
  const pa = describePriceAction(H[pair] || [], { pair, asOfCloseMs: t });
  const c = classify(pair, H, { asOfCloseMs: t, network: net, prevState: prev });
  const h24 = net.windows ? net.windows.h24 : null;
  const cov = h24 && h24.coverage ? h24.coverage : { pairsUsed: 0, pairsExpected: 28 };
  const lastOpen = t - M15;
  const staleBefore = (pa.integrity && pa.integrity.gaps || []).some((g) => g.toMs === lastOpen);
  const insufficient = !pa.state || pa.state.label === 'NO_DATA' || pa.state.label === 'INSUFFICIENT_DATA';

  let availReason = null, available = true;
  if (insufficient) { available = false; availReason = pa.state && pa.state.label === 'NO_DATA' ? 'NO_DATA' : 'INSUFFICIENT_DATA'; }
  else if (!h24 || !h24.available) { available = false; availReason = `UNSYNCHRONIZED (${h24 ? h24.reason : 'NO_NETWORK'})`; }
  else if (cov.pairsUsed < cov.pairsExpected) { available = false; availReason = `INCOMPLETE_COVERAGE (${cov.pairsUsed}/${cov.pairsExpected})`; }

  const story = (w) => (w && w.descriptors ? { coveragePct: w.coveragePct, actual: w.actualCandles, nominal: w.nominalCandles, efficiency: w.descriptors.directionalEfficiency, direction: w.descriptors.direction, range: w.descriptors.range, positionInRange: w.descriptors.positionInRange } : null);
  const board = (h24 && h24.available) ? h24.effects.ranked.map((ccy) => ({ currency: ccy, x: h24.effects.byCurrency[ccy], breadth: h24.breadth[ccy] ? h24.breadth[ccy].fraction : 0 })) : null;
  // Per-currency strength across ALL four windows (12/24/36/48h).
  const strengthByWindow = {};
  for (const k of ['h12', 'h24', 'h36', 'h48']) { const w = net.windows ? net.windows[k] : null; strengthByWindow[k] = (w && w.available) ? w.effects.byCurrency : null; }
  const conf = (net.leaveOnePairOut && net.leaveOnePairOut.confirmations && net.leaveOnePairOut.confirmations[pair]) || null;
  const nc = nextConditionFor(c.primaryState, c.structure);

  return {
    candleIdx, asOfCloseMs: t, asOfCloseUtc: c.asOfCloseUtc, asOfCloseEat: c.asOfCloseEat,
    primaryState: c.primaryState, previousState: c.previousState, transition: c.transition,
    windows: c.windows,
    priceStories: { h12: story(pa.windows && pa.windows.h12), h24: story(pa.windows && pa.windows.h24), h36: story(pa.windows && pa.windows.h36), h48: story(pa.windows && pa.windows.h48) },
    compare12: pa.comparison ? { latestEff: pa.comparison.latest12.directionalEfficiency, previousEff: pa.comparison.previous12.directionalEfficiency, deltaEff: pa.comparison.deltaEfficiency, latestDir: pa.comparison.latest12.direction, previousDir: pa.comparison.previous12.direction } : null,
    strengthBoard: board,
    strengthByWindow: strengthByWindow,
    otherPairConfirmation: conf ? { full: conf.full ? conf.full.baseMinusQuote : null, leaveOut: conf.leaveOut ? conf.leaveOut.baseMinusQuote : null, agrees: conf.independentlyConfirmed, note: 'leave-one-pair-out = OTHER-PAIR confirmation (this pair excluded); not statistical independence.' } : null,
    events: (pa.events || []).map((e) => ({ ms: e.ms, utc: new Date(e.ms).toISOString(), type: e.type, evidence: e.evidence })),
    structure: { acceptedHold: c.structure.acceptedHold, acceptedHoldDir: c.structure.acceptedHoldDir, confirmedPivots: c.structure.confirmedPivots, lastPivot: c.structure.lastPivot, provisionalLeg: c.structure.provisionalLeg, rejection: c.structure.rejection },
    evidenceFor: (c.evidenceFor || []).map((e) => e.text),
    evidenceAgainst: (c.evidenceAgainst || []).map((e) => e.text),
    explanation: c.explanation,
    nextCondition: nc.nextCondition, invalidationReference: nc.invalidationReference, invalidationLevel: nc.invalidationLevel,
    extendedMove: extendedMoveFlag(pa),
    dataHealth: { available, reason: availReason, stale: staleBefore, closedMarket: closedMarket(t), aligned: !!(h24 && h24.available && cov.pairsUsed === cov.pairsExpected), pairsPresent: cov.pairsUsed, pairsExpected: cov.pairsExpected },
    calibrationVersion: c.calibration.version,
  };
}

const MODEL_HEALTH = Object.freeze({
  status: 'UNVALIDATED',
  stage5: { decision: 'NONE PASSED', immutable: true, artifact: 'docs/research/audit/stage5_scorecard_CORRECTED.json' },
  infocontent: { verdicts: { H1: 'INSUFFICIENT_EVIDENCE', H2: 'INSUFFICIENT_EVIDENCE', H3: 'INSUFFICIENT_EVIDENCE' }, registrationHash: 'c5a26dd1582726d5267694e75397c9dea28c1d36f2df5265cf1698408e4dd6b6', economics: 'ESTIMATED (mid-only)', note: 'No tradable edge demonstrated. No profitability or confidence probability is shown anywhere.' },
});

/**
 * Pure payload builder over synchronized histories H (no DB/IO).
 * @param H { pair: candles[] } ascending research-shape candles.
 * @param opts { pairs?, frames? (N closes), now?, provenance? }
 */
function buildWorkspacePayload(H, opts = {}) {
  const pairs = opts.pairs || PAIRS;
  const N = opts.frames || 48;
  const now = opts.now != null ? opts.now : Date.now();
  const provenance = opts.provenance || 'LIVE';

  const probe = syncAsOf(H, now);
  const meta = { version: 'm15-workspace-1.0.0', classifier: CLASSIFIER_VERSION, calibration: CALIBRATION.version, provenance, generatedAtUtc: new Date().toISOString(), disclaimer: provenance === 'LIVE' ? 'Research classification — not a trade signal. Model UNVALIDATED (no demonstrated edge). Mid-only candles; no order path.' : 'DEMO / SYNTHETIC — not live, not a trading system, not validated for profitability.' };
  if (probe.frameOpenMs == null) return { meta, modelHealth: MODEL_HEALTH, watchlist: [], available: false, reason: 'NO_DATA', missing: probe.missing };
  const T = probe.frameOpenMs + M15;

  // Build the close grid from the union of pair candle closes ≤ T (last N distinct).
  const closeSet = new Set();
  for (const p of pairs) for (const c of (H[p] || [])) { const cm = c.openMs + M15; if (cm <= T) closeSet.add(cm); }
  const closes = [...closeSet].sort((a, b) => a - b).slice(-N);

  // Per-pair candle arrays + close→index maps for the chart.
  const candlesByPair = {}, idxByPair = {};
  for (const p of pairs) {
    const cs = (H[p] || []).filter((c) => c.openMs + M15 <= T).sort((a, b) => a.openMs - b.openMs);
    candlesByPair[p] = cs.map((c) => ({ openMs: c.openMs, open: c.open, high: c.high, low: c.low, close: c.close }));
    const m = new Map(); cs.forEach((c, i) => m.set(c.openMs + M15, i)); idxByPair[p] = { map: m, closes: cs.map((c) => c.openMs + M15) };
  }
  const lastIdxAtOrBefore = (p, t) => { const arr = idxByPair[p].closes; let lo = 0, hi = arr.length - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; } return ans; };

  const framesByPair = {}; const prev = {};
  for (const p of pairs) framesByPair[p] = [];
  for (const t of closes) {
    const net = describeNetwork(H, { asOfCloseMs: t });
    for (const p of pairs) {
      const ci = idxByPair[p].map.has(t) ? idxByPair[p].map.get(t) : lastIdxAtOrBefore(p, t);
      const f = buildFrame(p, H, t, prev[p] != null ? prev[p] : null, ci < 0 ? 0 : ci, net);
      framesByPair[p].push(f); prev[p] = f.primaryState;
    }
  }

  const watchlist = pairs.map((p) => ({ pair: p, label: p.replace('_', '/'), candles: candlesByPair[p], frames: framesByPair[p] }));
  return { meta, modelHealth: MODEL_HEALTH, watchlist, available: true, asOfCloseUtc: new Date(T).toISOString() };
}

module.exports = { M15, closedMarket, nextConditionFor, extendedMoveFlag, buildFrame, buildWorkspacePayload, MODEL_HEALTH };
