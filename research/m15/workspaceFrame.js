'use strict';

const crypto = require('crypto');
const CODE_VERSION = 'm15-workspace-1.1.0';

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

// ── simplified decision labels (detailed engine state → plain label + qualifiers) ──
function simpleStateOf(state, extendedMove) {
  const q = [];
  let label = state;
  if (state === 'UNAVAILABLE') label = 'Unavailable';
  else if (state === 'CONFLICT') label = 'Conflict';
  else if (/^REVERSAL/.test(state)) label = 'Reversal';
  else if (/^BALANCED_RANGE/.test(state)) label = 'Range';
  else if (/^EMERGING_MOVE/.test(state)) label = 'Developing trend';
  else if (/^ACCEPTED_TREND|^ACCELERATING_TREND|^EXHAUSTION_RISK/.test(state)) label = 'Established trend';
  if (/^ACCELERATING/.test(state)) q.push('Accelerating');
  if (/^EXHAUSTION_RISK/.test(state)) q.push('Exhaustion risk');
  if (extendedMove) q.push('Extended');
  const dir = /_UP$/.test(state) ? 'UP' : (/_DOWN$/.test(state) ? 'DOWN' : null);
  return { label: label, dir: dir, qualifiers: q, engineState: state };
}

const dirWord = (dir, up, down, flat) => (dir === 'UP' ? up : dir === 'DOWN' ? down : flat);

// ── direction (structure) vs timing (location/entry) — kept separate on purpose ──
function directionTimingOf(simple, pa, structure, nc, extendedMove) {
  const posObj = pa.windows && pa.windows.h24 && pa.windows.h24.descriptors;
  const pos = posObj ? posObj.positionInRange : 0.5;
  const dir = simple.dir;
  let direction;
  if (simple.label === 'Established trend') direction = dirWord(dir, 'Established bullish structure', 'Established bearish structure', 'Established (direction unclear)');
  else if (simple.label === 'Developing trend') direction = dirWord(dir, 'Developing bullish move', 'Developing bearish move', 'Developing move');
  else if (simple.label === 'Reversal') direction = dirWord(dir, 'Turning bullish (reversal of prior context)', 'Turning bearish (reversal of prior context)', 'Reversal');
  else if (simple.label === 'Range') direction = 'No established direction (range/balance)';
  else if (simple.label === 'Conflict') direction = 'Price and other-pair support disagree';
  else direction = 'Unavailable';

  let location;
  if (simple.label === 'Unavailable') location = 'No reliable location';
  else if (extendedMove) location = dirWord(dir, 'Extended above the recent accepted area', 'Extended below the recent accepted area', 'Extended from value');
  else if (structure.acceptedHold) location = dirWord(dir, 'Beyond an accepted area (held higher)', 'Beyond an accepted area (held lower)', 'Beyond an accepted area');
  else if (pos <= 0.2) location = 'Near the low of the 24h range';
  else if (pos >= 0.8) location = 'Near the high of the 24h range';
  else location = 'Mid 24h range';

  const nextObservation = nc.invalidationReference || nc.nextCondition || '—';
  return { direction: direction, location: location, nextObservation: nextObservation, entryEligibility: 'No validated entry rule available (model UNVALIDATED)' };
}

// ── strongest competing interpretation + what would distinguish it ──
function alternativeOf(simple, pa) {
  const dir = simple.dir;
  const overlap = pa.windows && pa.windows.h24 && pa.windows.h24.descriptors ? pa.windows.h24.descriptors.overlapFraction : 0;
  const L = simple.label;
  if (L === 'Developing trend') return { interpretation: dirWord(dir, 'Possible new bullish departure, but the broader range may reject the advance.', 'Possible new bearish departure, but the broader range has repeatedly rejected declines.', 'Possible new move, but the range may absorb it.'), distinguisher: 'A decisive close beyond the range edge vs a close back inside.' };
  if (L === 'Established trend') return { interpretation: 'Direction is clear but may be late/extended; a move against it could be a pullback, not a turn.', distinguisher: dirWord(dir, 'A higher low that holds vs a failure back below support.', 'A lower high that holds vs a reclaim of the last broken area.', 'Continuation vs a failed break.') };
  if (L === 'Reversal') return { interpretation: 'Could be a genuine turn, or just a counter-move within the prior trend.', distinguisher: dirWord(dir, 'Acceptance above the broken level vs rejection back below.', 'Acceptance below the broken level vs rejection back above.', 'Acceptance vs rejection of the pivot.') };
  if (L === 'Range') return { interpretation: overlap >= 0.7 ? 'Tight balance; may resolve either way with little warning.' : 'Rotational; no edge in control yet.', distinguisher: 'The first accepted break of the balance zone.' };
  if (L === 'Conflict') return { interpretation: 'Price points one way while other-pair support points the other.', distinguisher: 'Which side the next few closes confirm.' };
  return { interpretation: '—', distinguisher: '—' };
}

// ── per-currency strength development across windows (gaining/holding/losing) ──
function strengthDevelopmentOf(sw) {
  if (!sw || !sw.h24) return null;
  const out = {};
  Object.keys(sw.h24).forEach((c) => {
    const x24 = sw.h24[c], x12 = sw.h12 ? sw.h12[c] : x24, x48 = sw.h48 ? sw.h48[c] : x24;
    const sign = Math.sign(x24) || 1;
    const dev = (x12 - x48) * sign;                 // recent minus longer, in the currency's direction
    const trend = Math.abs(dev) < 0.0003 ? 'holding' : (dev > 0 ? 'gaining' : 'losing');
    out[c] = { x24: +(+x24).toFixed(6), dev: +dev.toFixed(6), trend: trend };
  });
  return out;
}

function inputDigest(cands, t) {
  const cs = (cands || []).filter((c) => c.openMs + 15 * 60 * 1000 <= t);
  let sum = 0; for (const c of cs) sum += c.close;
  const last = cs[cs.length - 1], first = cs[0];
  const payload = cs.length + '|' + (first ? first.openMs : '') + '|' + (last ? last.openMs + ':' + last.close : '') + '|' + sum.toFixed(6);
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 12);
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
  const extended = extendedMoveFlag(pa);
  const simple = simpleStateOf(c.primaryState, extended);
  const directionTiming = directionTimingOf(simple, pa, c.structure, nc, extended);
  const alternative = alternativeOf(simple, pa);
  const strengthDevelopment = strengthDevelopmentOf(strengthByWindow);

  return {
    candleIdx, asOfCloseMs: t, asOfCloseUtc: c.asOfCloseUtc, asOfCloseEat: c.asOfCloseEat,
    primaryState: c.primaryState, previousState: c.previousState, transition: c.transition,
    windows: c.windows,
    priceStories: { h12: story(pa.windows && pa.windows.h12), h24: story(pa.windows && pa.windows.h24), h36: story(pa.windows && pa.windows.h36), h48: story(pa.windows && pa.windows.h48) },
    compare12: pa.comparison ? { latestEff: pa.comparison.latest12.directionalEfficiency, previousEff: pa.comparison.previous12.directionalEfficiency, deltaEff: pa.comparison.deltaEfficiency, latestDir: pa.comparison.latest12.direction, previousDir: pa.comparison.previous12.direction } : null,
    simpleState: simple,
    directionTiming: directionTiming,
    alternative: alternative,
    strengthBoard: board,
    strengthByWindow: strengthByWindow,
    strengthDevelopment: strengthDevelopment,
    otherPairConfirmation: conf ? { full: conf.full ? conf.full.baseMinusQuote : null, leaveOut: conf.leaveOut ? conf.leaveOut.baseMinusQuote : null, agrees: conf.independentlyConfirmed, note: 'Other-pair support (this pair excluded). Currencies are correlated, so this is OTHER-PAIR support, not statistical independence.' } : null,
    events: (pa.events || []).map((e) => ({ ms: e.ms, utc: new Date(e.ms).toISOString(), type: e.type, evidence: e.evidence })),
    structure: { acceptedHold: c.structure.acceptedHold, acceptedHoldDir: c.structure.acceptedHoldDir, confirmedPivots: c.structure.confirmedPivots, lastPivot: c.structure.lastPivot, provisionalLeg: c.structure.provisionalLeg, rejection: c.structure.rejection },
    evidenceFor: (c.evidenceFor || []).map((e) => e.text),
    evidenceAgainst: (c.evidenceAgainst || []).map((e) => e.text),
    explanation: c.explanation,
    nextCondition: nc.nextCondition, invalidationReference: nc.invalidationReference, invalidationLevel: nc.invalidationLevel,
    extendedMove: extended,
    dataHealth: { available, reason: availReason, stale: staleBefore, closedMarket: closedMarket(t), aligned: !!(h24 && h24.available && cov.pairsUsed === cov.pairsExpected), pairsPresent: cov.pairsUsed, pairsExpected: cov.pairsExpected },
    // versioned reproducibility: the inputs + code/config that produced this frame
    reproduce: { inputDigest: inputDigest(H[pair], t), classifierVersion: c.version || null, calibrationVersion: c.calibration.version, codeVersion: CODE_VERSION },
    calibrationVersion: c.calibration.version,
  };
}

const MODEL_HEALTH = Object.freeze({
  status: 'UNVALIDATED',
  stage5: { decision: 'NONE PASSED', immutable: true, artifact: 'docs/research/audit/stage5_scorecard_CORRECTED.json' },
  infocontent: {
    verdicts: { H1: 'INSUFFICIENT_EVIDENCE', H2: 'INSUFFICIENT_EVIDENCE', H3: 'INSUFFICIENT_EVIDENCE' },
    registrationHash: 'c5a26dd1582726d5267694e75397c9dea28c1d36f2df5265cf1698408e4dd6b6',
    economics: 'ESTIMATED (mid-only)',
    // WHY insufficient — tells you what further work could resolve it:
    insufficientBecause: [
      'No real held-out data was evaluated (synthetic/exploratory provenance).',
      'Too few independent episodes and ISO-week blocks to bound uncertainty.',
      'Costs are ESTIMATED only (mid-only candles; no bid/ask).',
    ],
    whatWouldResolve: 'Run the frozen pre-registration on real held-out candles with actual bid/ask, across many weeks, to get enough independent episodes.',
    note: 'No tradable edge demonstrated. No profitability or confidence probability is shown anywhere.',
  },
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
  const meta = { version: CODE_VERSION, classifier: CLASSIFIER_VERSION, calibration: CALIBRATION.version, provenance, generatedAtUtc: new Date().toISOString(), disclaimer: provenance === 'LIVE' ? 'Research classification — not a trade signal. Model UNVALIDATED (no demonstrated edge). Mid-only candles; no order path.' : 'DEMO / SYNTHETIC — not live, not a trading system, not validated for profitability.' };
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

  // ── Freshness contract: three distinct timestamps + missing closed candles ──
  let newestIngestMs = 0;
  for (const p of pairs) for (const c of (H[p] || [])) { const cm = c.openMs + M15; if (cm > newestIngestMs) newestIngestMs = cm; }
  // completed M15 closes expected between the analysed close T and now, during open market
  let missing = 0;
  for (let tt = T + M15; tt <= now && (tt - T) <= 14 * 24 * 60 * 60 * 1000; tt += M15) { if (!closedMarket(tt - M15)) missing++; }
  const freshness = {
    lastClosedCandleUtc: new Date(T).toISOString(),        // the close the analysis is as-of
    lastIngestionUtc: newestIngestMs ? new Date(newestIngestMs).toISOString() : null,  // newest candle we hold
    analysisCompletedUtc: new Date().toISOString(),         // when this response was built
    missingClosedCandles: missing,
    marketClosed: closedMarket(now),
    delayed: missing >= 1,
  };
  return { meta, modelHealth: MODEL_HEALTH, watchlist, available: true, asOfCloseUtc: new Date(T).toISOString(), freshness };
}

module.exports = { M15, closedMarket, nextConditionFor, extendedMoveFlag, buildFrame, buildWorkspacePayload, MODEL_HEALTH };
