'use strict';

/**
 * Four W1→H4 opportunity types, evaluated AS-OF a time t (causal, price-action only;
 * no indicators). Each has a versioned contract. Every candidate is UNVALIDATED
 * research — a ranked candidate is NOT a demonstrated profitable trade.
 *
 *   1. PULLBACK          — legacy continuation (the original restrictive engine; its
 *                          rules apply to THIS approach only, never to the others).
 *   2. RANGE_REJECTION   — boundary test + rejection back into an established balance.
 *   3. ACCEPTED_BREAKOUT — H4 accepted departure from a weekly reference.
 *   4. FAILED_BREAKOUT   — attempted departure fails and price reclaims the range.
 *
 * Shared lifecycle states (map to UI sort groups):
 *   CONTEXT_MISSING · NO_SETUP · FORMING · CONFIRMED · OBJECTIVE_UNAVAILABLE ·
 *   INELIGIBLE_ECONOMICS · INVALIDATED
 */

const { buildMarketContext } = require('./weeklyContext');
const { balanceWalk, latestEpisode } = require('./balanceWalk');
const { buildFrame } = require('./frame');
const { pipSize } = require('./config');

const CONTRACTS = {
  RANGE_REJECTION: 'range-rejection-1.0.0',
  ACCEPTED_BREAKOUT: 'accepted-breakout-1.0.0',
  FAILED_BREAKOUT: 'failed-breakout-1.0.0',
  PULLBACK: 'paw1h4-pullback-1.1.0 (legacy)',
  acceptN: 2,            // consecutive H4 closes beyond a boundary = acceptance
  expiryH4Bars: 30,      // a forming candidate expires this many H4 bars after its trigger event
};

const iso = (ms) => (ms == null || !isFinite(ms) ? null : new Date(ms).toISOString());

// Economic eligibility: entry→objective vs entry→invalidation after costs, with the
// documented 2:1 research gate. NOT a profitability claim. Objective must be beyond
// entry in the trade direction, else UNAVAILABLE.
function economics(dir, entryPrice, invalidation, objective, pair, cfg) {
  const pip = pipSize(pair), ex = cfg.execution, d = dir === 'BUY' ? 1 : -1;
  if (entryPrice == null) return { economicEligibility: 'UNAVAILABLE', reason: 'no entry price yet' };
  if (objective == null || d * (objective - entryPrice) <= 0) return { economicEligibility: 'UNAVAILABLE', reason: 'no eligible objective beyond entry' };
  const riskPrice = Math.abs(entryPrice - invalidation);
  if (!(riskPrice > 0)) return { economicEligibility: 'INELIGIBLE', reason: 'zero risk' };
  const rewardPrice = Math.abs(objective - entryPrice);
  const exitCost = (ex.spreadPips / 2 + ex.slippagePips + ex.commissionPips) * pip;
  const rr = (rewardPrice - exitCost) / riskPrice;
  const ok = rr >= cfg.minRewardRisk;
  return { economicEligibility: ok ? 'ELIGIBLE' : 'INELIGIBLE', rewardRisk: +rr.toFixed(2), riskPips: +(riskPrice / pip).toFixed(1), rewardPips: +(rewardPrice / pip).toFixed(1), reason: ok ? null : `R:R ${rr.toFixed(2)} below ${cfg.minRewardRisk}:1 after costs` };
}

// First completed H4 bar after `afterIdx` whose close progresses AWAY in `dir`
// (long: close above that bar's high; short: close below its low). Returns the entry.
function confirmProgress(h4, afterIdx, refBar, dir) {
  const d = dir === 'BUY' ? 1 : -1;
  for (let k = afterIdx + 1; k < h4.length; k++) {
    const ok = d > 0 ? h4[k].close > refBar.high : h4[k].close < refBar.low;
    if (ok) {
      const entryBar = h4[k + 1] || null;
      return { confirmedMs: h4[k].closeMs, confirmBarIdx: k, entryBarIdx: entryBar ? k + 1 : null, entryOpenMs: entryBar ? entryBar.openMs : null, entryPrice: entryBar ? entryBar.open : null };
    }
  }
  return null;
}

function base(approach, dir, cfg) {
  return { approach, version: CONTRACTS[approach], dir, state: 'NO_SETUP', rejectionReasons: [], eventId: null, timestamps: {} };
}

// ── 2. RANGE-BOUNDARY REJECTION ────────────────────────────────────────────────
function detectRangeRejection(ctx, cfg) {
  const out = [];
  for (const dir of ['BUY', 'SELL']) {
    const c = base('RANGE_REJECTION', dir, cfg);
    const boundary = dir === 'BUY' ? 'lower' : 'upper';
    if (!ctx.balance || !ctx.balance.confirmed) { c.state = 'CONTEXT_MISSING'; c.rejectionReasons.push('no established weekly balance'); out.push(c); continue; }
    const h4 = ctx._internal.h4, bal = ctx.balance, buffer = ctx._internal.buffer, pip = ctx._internal.pip;
    const walk = balanceWalk(h4, bal, { acceptN: CONTRACTS.acceptN, fromMs: Date.parse(bal.establishedUtc) });
    const ep = latestEpisode(walk, (e) => e.boundary === boundary && e.kind === 'REJECTION');
    if (!ep) { c.state = 'NO_SETUP'; c.rejectionReasons.push(`no ${boundary}-boundary rejection (wick test) in the current balance`); out.push(c); continue; }
    c.eventId = `REJ:${boundary}:${ep.startMs}`;
    c.reference = { boundary, price: dir === 'BUY' ? bal.lower : bal.upper };
    c.frozenExtreme = ep.extreme;
    c.invalidation = dir === 'BUY' ? +(ep.extreme - buffer).toFixed(8) : +(ep.extreme + buffer).toFixed(8);
    c.objective = bal.mid; c.objectiveReason = 'frozen balance midpoint (v1)';
    c.timestamps = { rejectionUtc: iso(ep.startMs) };
    const conf = confirmProgress(h4, ep.startIdx, h4[ep.startIdx], dir);
    if (!conf) { c.state = 'FORMING'; c.rejectionReasons.push('rejection seen; awaiting a completed H4 close progressing away from the boundary'); out.push(c); continue; }
    Object.assign(c.timestamps, { confirmedUtc: iso(conf.confirmedMs), entryOpenUtc: iso(conf.entryOpenMs) });
    c.entryBarIdx = conf.entryBarIdx; c.entryPrice = conf.entryPrice;
    const econ = economics(dir, conf.entryPrice, c.invalidation, c.objective, ctx.pair, cfg);
    c.economics = econ;
    c.state = econ.economicEligibility === 'ELIGIBLE' ? 'CONFIRMED' : (econ.economicEligibility === 'UNAVAILABLE' ? 'OBJECTIVE_UNAVAILABLE' : 'INELIGIBLE_ECONOMICS');
    if (econ.reason) c.rejectionReasons.push(econ.reason);
    out.push(c);
  }
  return out;
}

// ── 3. ACCEPTED BREAKOUT ───────────────────────────────────────────────────────
function detectAcceptedBreakout(ctx, cfg) {
  const out = [];
  for (const dir of ['BUY', 'SELL']) {
    const c = base('ACCEPTED_BREAKOUT', dir, cfg);
    const boundary = dir === 'BUY' ? 'upper' : 'lower';
    // Reference: a balance boundary when a balance exists, else the latest confirmed weekly swing in that direction.
    let refPrice = null, refKind = null, fromMs = -Infinity;
    if (ctx.balance) { refPrice = dir === 'BUY' ? ctx.balance.upper : ctx.balance.lower; refKind = 'weekly balance boundary'; fromMs = Date.parse(ctx.balance.establishedUtc); }
    else {
      const arr = dir === 'BUY' ? ctx.references.structuralHighs : ctx.references.structuralLows;
      if (arr.length) { refPrice = arr[arr.length - 1].price; refKind = 'confirmed weekly swing level'; fromMs = Date.parse(arr[arr.length - 1].knownUtc); }
    }
    if (refPrice == null) { c.state = 'CONTEXT_MISSING'; c.rejectionReasons.push('no weekly reference (balance boundary or confirmed swing) to depart from'); out.push(c); continue; }
    const h4 = ctx._internal.h4, buffer = ctx._internal.buffer;
    const band = { upper: dir === 'BUY' ? refPrice : Infinity, lower: dir === 'BUY' ? -Infinity : refPrice };
    const walk = balanceWalk(h4, band, { acceptN: CONTRACTS.acceptN, fromMs });
    const ep = latestEpisode(walk, (e) => e.boundary === boundary && e.kind === 'ACCEPTED');
    c.reference = { price: refPrice, kind: refKind };
    if (!ep) { c.state = 'NO_SETUP'; c.rejectionReasons.push(`no H4 accepted departure beyond the ${refKind}`); out.push(c); continue; }
    // "Accepted" also requires progress (not two closes alone): the extreme beyond must
    // extend past the first close beyond, in the departure direction.
    const d = dir === 'BUY' ? 1 : -1;
    const progressed = d > 0 ? ep.extreme > refPrice + buffer : ep.extreme < refPrice - buffer;
    if (!progressed) { c.state = 'FORMING'; c.rejectionReasons.push('closes beyond the reference but acceptance not yet demonstrated by progress'); out.push(c); continue; }
    c.eventId = `ACC:${boundary}:${ep.startMs}`;
    c.label = 'H4 accepted departure from a weekly reference (NOT a completed weekly breakout)';
    c.frozenExtreme = ep.extreme;
    c.invalidation = dir === 'BUY' ? +(refPrice - buffer).toFixed(8) : +(refPrice + buffer).toFixed(8);   // back inside past the reference
    // Objective: next confirmed weekly structural level beyond the current extreme.
    const levels = dir === 'BUY' ? ctx.references.structuralHighs.map((h) => h.price).filter((p) => p > ep.extreme) : ctx.references.structuralLows.map((l) => l.price).filter((p) => p < ep.extreme);
    c.objective = levels.length ? (dir === 'BUY' ? Math.min.apply(null, levels) : Math.max.apply(null, levels)) : null;
    c.objectiveReason = c.objective != null ? 'next confirmed weekly structural level beyond' : 'no structural level beyond — trade evaluation unavailable, structural observation retained';
    c.timestamps = { acceptedUtc: iso(ep.acceptedMs || ep.startMs) };
    const entryBar = h4[(ep.acceptedIdx != null ? ep.acceptedIdx : ep.startIdx) + 1] || null;
    c.entryBarIdx = entryBar ? (ep.acceptedIdx != null ? ep.acceptedIdx : ep.startIdx) + 1 : null;
    c.entryPrice = entryBar ? entryBar.open : null;
    c.timestamps.entryOpenUtc = iso(entryBar ? entryBar.openMs : null);
    const econ = economics(dir, c.entryPrice, c.invalidation, c.objective, ctx.pair, cfg);
    c.economics = econ;
    c.state = econ.economicEligibility === 'ELIGIBLE' ? 'CONFIRMED' : (econ.economicEligibility === 'UNAVAILABLE' ? 'OBJECTIVE_UNAVAILABLE' : 'INELIGIBLE_ECONOMICS');
    if (econ.reason) c.rejectionReasons.push(econ.reason);
    out.push(c);
  }
  return out;
}

// ── 4. FAILED BREAKOUT ─────────────────────────────────────────────────────────
function detectFailedBreakout(ctx, cfg) {
  const out = [];
  for (const dir of ['BUY', 'SELL']) {
    const c = base('FAILED_BREAKOUT', dir, cfg);
    // Long = a DOWNWARD departure fails (reclaim up); short = an upward departure fails.
    const boundary = dir === 'BUY' ? 'lower' : 'upper';
    if (!ctx.balance || !ctx.balance.confirmed) { c.state = 'CONTEXT_MISSING'; c.rejectionReasons.push('no established weekly balance'); out.push(c); continue; }
    const h4 = ctx._internal.h4, bal = ctx.balance, buffer = ctx._internal.buffer;
    const walk = balanceWalk(h4, bal, { acceptN: CONTRACTS.acceptN, fromMs: Date.parse(bal.establishedUtc) });
    const ep = latestEpisode(walk, (e) => e.boundary === boundary && e.kind === 'FAILED');
    if (!ep) { c.state = 'NO_SETUP'; c.rejectionReasons.push(`no attempted ${boundary} departure that reclaimed the range`); out.push(c); continue; }
    c.eventId = `FAIL:${boundary}:${ep.startMs}`;
    c.priorAccepted = ep.accepted;   // chronological transition: an accepted breakout that later failed
    c.reference = { boundary, price: dir === 'BUY' ? bal.lower : bal.upper };
    c.frozenExtreme = ep.extreme;
    c.invalidation = dir === 'BUY' ? +(ep.extreme - buffer).toFixed(8) : +(ep.extreme + buffer).toFixed(8);
    c.objective = bal.mid; c.objectiveReason = 'frozen balance midpoint (v1) — return-into-range (NOT a weekly trend reversal)';
    c.timestamps = { departedUtc: iso(ep.startMs), reclaimedUtc: iso(ep.reclaimMs) };
    const conf = confirmProgress(h4, ep.reclaimIdx, h4[ep.reclaimIdx], dir);
    if (!conf) { c.state = 'FORMING'; c.rejectionReasons.push('reclaim seen; awaiting a completed H4 close confirming the failure (progress back into range)'); out.push(c); continue; }
    Object.assign(c.timestamps, { confirmedUtc: iso(conf.confirmedMs), entryOpenUtc: iso(conf.entryOpenMs) });
    c.entryBarIdx = conf.entryBarIdx; c.entryPrice = conf.entryPrice;
    const econ = economics(dir, conf.entryPrice, c.invalidation, c.objective, ctx.pair, cfg);
    c.economics = econ;
    c.state = econ.economicEligibility === 'ELIGIBLE' ? 'CONFIRMED' : (econ.economicEligibility === 'UNAVAILABLE' ? 'OBJECTIVE_UNAVAILABLE' : 'INELIGIBLE_ECONOMICS');
    if (econ.reason) c.rejectionReasons.push(econ.reason);
    out.push(c);
  }
  return out;
}

// ── 1. PULLBACK (legacy) ───────────────────────────────────────────────────────
function detectPullback(h1, pair, asOfMs, cfg) {
  const f = buildFrame(h1, pair, asOfMs, cfg);   // legacy W1→H4 engine frame
  const dir = f.h4.dir || (f.weekly.bias === 'BULLISH' ? 'BUY' : f.weekly.bias === 'BEARISH' ? 'SELL' : null);
  const c = base('PULLBACK', dir, cfg);
  c.legacy = true;
  c.state = f.h4.state === 'TRIGGERED' ? 'CONFIRMED' : (['ARMED', 'WAITING_FOR_RETEST_STRUCTURE', 'FIRST_BREAK', 'PULLBACK_ACTIVE'].includes(f.h4.state) ? 'FORMING' : (f.h4.state === 'WAITING_FOR_PULLBACK' ? 'NO_SETUP' : 'CONTEXT_MISSING'));
  c.engineState = f.h4.state;
  c.reference = { price: f.h4.breakLevel, kind: 'frozen pullback break level' };
  c.invalidation = f.h4.stopRef; c.frozenExtreme = f.h4.pullbackExtreme;
  if (f.suggestedTrade) { c.objective = f.suggestedTrade.target; c.objectiveReason = 'nearest opposing weekly level'; c.economics = { economicEligibility: 'ELIGIBLE', rewardRisk: f.suggestedTrade.rewardRisk, riskPips: f.suggestedTrade.riskPips, rewardPips: f.suggestedTrade.rewardPips }; c.entryPrice = f.suggestedTrade.entryFill; }
  else if (f.rejection) { c.economics = { economicEligibility: 'INELIGIBLE', reason: f.rejection.reason }; if (c.state === 'CONFIRMED') c.state = 'INELIGIBLE_ECONOMICS'; c.rejectionReasons.push(f.rejection.reason); }
  c.timestamps = { bosUtc: f.weekly.recentBos && f.weekly.recentBos.candleCloseUtc };
  return c;
}

// ── Combined evaluation + ranking ──────────────────────────────────────────────
const GROUP = { CONFIRMED: 0, FORMING: 1, OBJECTIVE_UNAVAILABLE: 2, INELIGIBLE_ECONOMICS: 3, NO_SETUP: 4, CONTEXT_MISSING: 5, INVALIDATED: 6 };

function evaluateApproaches(h1, pair, asOfMs, cfg) {
  const ctx = buildMarketContext(h1, asOfMs, cfg, pair);
  const candidates = []
    .concat([detectPullback(h1, pair, asOfMs, cfg)])
    .concat(detectRangeRejection(ctx, cfg))
    .concat(detectAcceptedBreakout(ctx, cfg))
    .concat(detectFailedBreakout(ctx, cfg));
  // transparent sort: group, then recency of the governing timestamp
  const recency = (c) => Math.max.apply(null, [0].concat(Object.values(c.timestamps || {}).map((v) => (v ? Date.parse(v) : 0))));
  candidates.sort((a, b) => (GROUP[a.state] - GROUP[b.state]) || (recency(b) - recency(a)));
  const funnel = {};
  for (const c of candidates) { const k = c.approach + ':' + c.dir; funnel[k] = { state: c.state, firstReason: c.rejectionReasons[0] || null, reasons: c.rejectionReasons }; }
  // strip internal handles from the serialized context
  const publicCtx = Object.assign({}, ctx); delete publicCtx._internal;
  return { context: publicCtx, candidates, funnel };
}

// ── Serializable frame for the /weekly-h4 page (charts + references + markers) ──
const agg = require('./aggregate');
function buildApproachFrame(h1, pair, asOfMs, cfg) {
  const ev = evaluateApproaches(h1, pair, asOfMs, cfg);
  const h4 = agg.h4(h1, asOfMs), w1 = agg.w1(h1, asOfMs);
  const bal = ev.context.balance;
  // H4 interaction markers against the balance band (observable event times).
  let markers = [];
  if (bal) {
    const walk = balanceWalk(h4, { upper: bal.upper, lower: bal.lower }, { acceptN: CONTRACTS.acceptN, fromMs: Date.parse(bal.establishedUtc) });
    markers = walk.episodes.concat(walk.ongoing ? [walk.ongoing] : []).map((e) => ({ kind: e.kind, boundary: e.boundary, atMs: e.startMs, extreme: e.extreme }));
  }
  const EAT = (ms) => new Date(ms + 3 * 3600000).toISOString().replace('.000Z', ' EAT').replace('T', ' ');
  return {
    strategyId: 'PA_W1_H4_MULTI', version: 'w1h4-multi-1.0.0', pair,
    asOfUtc: new Date(asOfMs).toISOString(), asOfEat: EAT(asOfMs),
    context: ev.context, candidates: ev.candidates, funnel: ev.funnel,
    references: {
      balance: bal ? { upper: bal.upper, lower: bal.lower, mid: bal.mid, confirmed: bal.confirmed } : null,
      structuralHighs: ev.context.references.structuralHighs,
      structuralLows: ev.context.references.structuralLows,
    },
    markers,
    w1candles: w1.slice(-40).map((c) => ({ t: c.openMs, o: c.open, h: c.high, l: c.low, c: c.close, partial: c.partial })),
    h4candles: h4.slice(-160).map((c) => ({ t: c.openMs, o: c.open, h: c.high, l: c.low, c: c.close, partial: c.partial })),
  };
}

// ── Light per-pair scan summary for the 28-pair scanner ────────────────────────
function scanApproaches(h1, pair, asOfMs, cfg) {
  const ev = evaluateApproaches(h1, pair, asOfMs, cfg);
  const best = ev.candidates[0] || null;
  const b = ev.context.balance;
  const freshness = best && best.timestamps ? Math.max.apply(null, [0].concat(Object.values(best.timestamps).map((v) => (v ? Date.parse(v) : 0)))) : 0;
  const GROUP_SCORE = { CONFIRMED: 100, FORMING: 60, OBJECTIVE_UNAVAILABLE: 40, INELIGIBLE_ECONOMICS: 30, NO_SETUP: 10, CONTEXT_MISSING: 5, INVALIDATED: 1 };
  return {
    pair, bias: ev.context.trend.bias,
    balance: b ? { confirmed: b.confirmed, lower: b.lower, upper: b.upper } : null,
    location: ev.context.location.zone,
    best: best ? { approach: best.approach, dir: best.dir, state: best.state, economics: best.economics || null, reason: best.rejectionReasons[0] || null } : null,
    freshnessUtc: freshness ? new Date(freshness).toISOString() : null,
    score: best ? (GROUP_SCORE[best.state] || 0) + (freshness ? 1 : 0) : 0,
  };
}

module.exports = { evaluateApproaches, buildApproachFrame, scanApproaches, detectRangeRejection, detectAcceptedBreakout, detectFailedBreakout, detectPullback, economics, CONTRACTS };
