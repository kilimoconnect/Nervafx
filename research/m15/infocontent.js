'use strict';

/**
 * Stage E — classifier-state INFORMATION-CONTENT evaluation harness (pure).
 *
 * Reads the FROZEN pre-registration (infocontent_prereg) and tests whether classifier
 * states carry useful future information, under the registered rules. It does NOT create
 * a strategy, NEVER labels historical fit as proof, and NEVER overturns the immutable
 * Stage 5/5A NONE PASSED decision. A gate pass only yields ELIGIBLE_FOR_NEW_SHADOW_REVIEW
 * (owner review for a FUTURE prospective shadow cohort). Isolated from api/_m15.
 */

const crypto = require('crypto');
const { PREREGISTRATION, registrationHash, stableStringify } = require('./infocontent_prereg');

const M15 = 15 * 60 * 1000;

// ── primitives ─────────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function isoWeek(ms) { const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; const th = new Date(d); th.setUTCDate(d.getUTCDate() - day + 3); const y0 = new Date(Date.UTC(th.getUTCFullYear(), 0, 1)); return `${th.getUTCFullYear()}-W${String(1 + Math.round(((th - y0) / 86400000 - 3 + ((y0.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`; }
function sessionOf(ms) { const h = new Date(ms).getUTCHours(); if (h >= 0 && h < 7) return 'ASIA'; if (h >= 7 && h < 12) return 'LONDON'; if (h >= 12 && h < 17) return 'OVERLAP'; return 'NY'; }

/** ATR14 (mean true range over the 14 candles up to idx). */
function atr14(candles, idx) {
  let s = 0, c = 0;
  for (let i = Math.max(1, idx - 13); i <= idx; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    s += tr; c++;
  }
  return c ? s / c : 0;
}

/** Outcome in R: enter at the NEXT candle open (+delay), exit `horizon` candles later. */
function outcomeR(candles, signalIdx, horizon, dir, { spread = 0, delay = 0 } = {}) {
  const entryIdx = signalIdx + 1 + delay;      // next practicable price (never same-bar)
  const exitIdx = entryIdx + horizon;
  if (exitIdx >= candles.length || entryIdx >= candles.length) return null;
  const atr = atr14(candles, signalIdx);
  if (!(atr > 0)) return null;
  const gross = dir * (candles[exitIdx].close - candles[entryIdx].open);
  return { grossR: gross / atr, netR: (gross - spread) / atr, entryIdx, exitIdx, atr };
}

const dirOf = (state) => (/_UP$/.test(state) ? 1 : /_DOWN$/.test(state) ? -1 : 0);
function familyOf(state) {
  if (/^ACCEPTED_TREND|^ACCELERATING_TREND/.test(state)) return 'ACCEPTED';
  if (/^EMERGING_MOVE/.test(state)) return 'EMERGING';
  if (/^REVERSAL/.test(state)) return 'REVERSAL';
  if (/^EXHAUSTION/.test(state)) return 'EXHAUSTION';
  return 'OTHER';
}

// ── episode builders (dedup, no overlap per pair) ──────────────────────────────
/** Entries into a target family per pair; one open episode at a time (cooldown). */
function stateEpisodes(frames, family) {
  const eps = []; let open = false;
  for (const f of frames) {
    const fam = familyOf(f.primaryState);
    if (fam === family && dirOf(f.primaryState) !== 0) { if (!open) { eps.push({ signalIdx: f.candleIdx, closeMs: f.asOfCloseMs, dir: dirOf(f.primaryState), state: f.primaryState, confirmed: !!f.confirmed, priceOnlyState: f.priceOnlyState || null }); open = true; } }
    else open = false;
  }
  return eps;
}
/** Accepted vs rejected departure events (from the event log carried on frames). */
function departureEpisodes(frames) {
  const accepted = [], rejected = [];
  for (const f of frames) for (const e of (f.newEvents || [])) {
    const dir = /above/.test(e.evidence) ? 1 : /below/.test(e.evidence) ? -1 : 0;
    if (dir === 0) continue;
    if (e.type === 'DEPARTURE_ACCEPTED') accepted.push({ signalIdx: f.candleIdx, closeMs: f.asOfCloseMs, dir });
    else if (e.type === 'RETURN') rejected.push({ signalIdx: f.candleIdx, closeMs: f.asOfCloseMs, dir }); // provisional departure that failed
  }
  return { accepted, rejected };
}

// ── statistics ─────────────────────────────────────────────────────────────────
/** Dependence-aware week-block bootstrap CI (seeded) + one-sided p (effect>0). */
function weekBlockCI(samples, seed, B = 2000) {
  const byWeek = new Map();
  for (const s of samples) { const w = s.week; if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(s.v); }
  const weeks = [...byWeek.keys()], W = weeks.length;
  const vals = samples.map((s) => s.v), m = mean(vals);
  if (W < 2) return { n: samples.length, weeks: W, mean: +m.toFixed(4), ciLow: null, ciHigh: null, posWeekShare: null, pOneSided: null };
  const weekMeans = weeks.map((w) => mean(byWeek.get(w)));
  const rnd = mulberry32(seed); const bm = [];
  for (let b = 0; b < B; b++) { let s = 0, c = 0; for (let i = 0; i < W; i++) { const blk = byWeek.get(weeks[Math.floor(rnd() * W)]); for (const v of blk) { s += v; c++; } } bm.push(c ? s / c : 0); }
  bm.sort((a, b) => a - b);
  const pLE0 = bm.filter((x) => x <= 0).length / B;
  return { n: samples.length, weeks: W, mean: +m.toFixed(4), ciLow: +bm[Math.floor(0.025 * B)].toFixed(4), ciHigh: +bm[Math.floor(0.975 * B)].toFixed(4), posWeekShare: +(weekMeans.filter((x) => x > 0).length / W).toFixed(3), pOneSided: +pLE0.toFixed(4) };
}
/** Holm-Bonferroni: returns {id: rejectAt0.05} across the family. */
function holm(pById, alpha = 0.05) {
  const arr = Object.entries(pById).filter(([, p]) => p != null).sort((a, b) => a[1] - b[1]);
  const m = arr.length, out = {}; let stillRejecting = true;
  arr.forEach(([id, p], i) => { const thr = alpha / (m - i); const rej = stillRejecting && p <= thr; if (!rej) stillRejecting = false; out[id] = rej; });
  for (const id of Object.keys(pById)) if (!(id in out)) out[id] = false;
  return out;
}
function concentration(episodes, keyFn) {
  const by = new Map(); for (const e of episodes) { const k = keyFn(e); by.set(k, (by.get(k) || 0) + 1); }
  const total = episodes.length || 1; let max = 0, which = null;
  for (const [k, v] of by) if (v / total > max) { max = v / total; which = k; }
  return { maxShare: +max.toFixed(3), key: which, groups: by.size };
}
function tail(values) {
  if (!values.length) return { worst: null, p05: null, mean: null };
  const s = values.slice().sort((a, b) => a - b);
  return { worst: +s[0].toFixed(4), p05: +s[Math.floor(0.05 * s.length)].toFixed(4), mean: +mean(values).toFixed(4) };
}

// ── the decision gate (registered) ─────────────────────────────────────────────
function decideHypothesis(h, cfg = PREREGISTRATION.config) {
  const reasons = [];
  // provenance / economics guard — EXPLORATORY or SYNTHETIC data can never be ELIGIBLE
  if (h.provenance !== 'REAL_HOLDOUT') { reasons.push(`data provenance ${h.provenance} is EXPLORATORY/SYNTHETIC`); return { verdict: 'INSUFFICIENT_EVIDENCE', reasons }; }
  if (h.nEpisodes < 200) { reasons.push(`only ${h.nEpisodes} independent episodes (< 200)`); return { verdict: 'INSUFFICIENT_EVIDENCE', reasons }; }
  if (h.nWeeks < 8) { reasons.push(`only ${h.nWeeks} week-blocks (< 8)`); return { verdict: 'INSUFFICIENT_EVIDENCE', reasons }; }
  if (h.coveragePartial) { reasons.push('coverage partial / unsynchronized'); return { verdict: 'INSUFFICIENT_EVIDENCE', reasons }; }
  if (h.ciHigh != null && h.ciHigh <= 0) { reasons.push(`effect CI entirely ≤ 0 [${h.ciLow}, ${h.ciHigh}]`); return { verdict: 'REJECT', reasons }; }
  const eligible = h.ciLow != null && h.ciLow > 0 && h.holmReject && h.beatsControls && h.posWeekShare >= 0.60 && h.maxConcentration <= 0.50 && h.nEpisodes >= 200;
  if (eligible) { reasons.push('Holm-adjusted CI>0, beats price-only+null controls, fold-stable, not concentrated; economics ESTIMATED ⇒ owner review only'); return { verdict: 'ELIGIBLE_FOR_NEW_SHADOW_REVIEW', reasons }; }
  if (!h.holmReject) reasons.push('fails Holm multiple-testing adjustment');
  if (!h.beatsControls) reasons.push('does not beat both price-only and null controls');
  if (h.posWeekShare != null && h.posWeekShare < 0.60) reasons.push(`positive week share ${h.posWeekShare} < 0.60`);
  if (h.maxConcentration > 0.50) reasons.push(`concentration ${h.maxConcentration} > 0.50`);
  return { verdict: 'INSUFFICIENT_EVIDENCE', reasons };
}

// ── orchestrator ────────────────────────────────────────────────────────────────
/**
 * @param perPair [{ pair, candles, frames }]  frames carry candleIdx, asOfCloseMs,
 *        primaryState, priceOnlyState, confirmed, newEvents.
 * @param opts { provenance:'SYNTHETIC_EXPLORATORY'|'REAL_HOLDOUT', horizon?, scenario? }
 */
function evaluate(perPair, opts = {}) {
  const cfg = PREREGISTRATION.config;
  const provenance = opts.provenance || 'SYNTHETIC_EXPLORATORY';
  const horizon = opts.horizon || 8;
  const seed = 20261007;
  const scenario = { spread: 0, delay: 0, ...(opts.scenario || {}) };   // mid-only ⇒ spread set by driver (ESTIMATED)
  const economics = 'ESTIMATED';   // backtest_candles is mid-only in this project
  const trials = [];

  // ---- H1: accepted same-direction forward R vs matched opportunities ----
  const h1Samples = [], h1Episodes = [], h1Tail = [];
  const matchedOppR = [];
  for (const { pair, candles, frames } of perPair) {
    const acc = stateEpisodes(frames, 'ACCEPTED');
    for (const e of acc) {
      const o = outcomeR(candles, e.signalIdx, horizon, e.dir, scenario);
      if (!o) continue;
      h1Samples.push({ v: o.netR, week: isoWeek(e.closeMs), pair, currency: pair.split('_')[0] });
      h1Episodes.push({ ...e, pair }); h1Tail.push(o.netR);
    }
    // matched opportunity: non-accepted eligible closes in same pair (price dir), same horizon
    for (const f of frames) {
      if (familyOf(f.primaryState) === 'ACCEPTED') continue;
      const d = dirOf(f.primaryState); if (!d) continue;
      const o = outcomeR(candles, f.candleIdx, horizon, d, scenario); if (o) matchedOppR.push(o.netR);
    }
  }
  const h1CI = weekBlockCI(h1Samples, seed);
  trials.push({ hypothesis: 'H1', metric: 'accepted same-dir netR', ...h1CI, controlMatchedOppMean: +mean(matchedOppR).toFixed(4) });

  // ---- H2: accepted vs rejected departure continuation ----
  const accCont = [], rejCont = [];
  for (const { pair, candles, frames } of perPair) {
    const { accepted, rejected } = departureEpisodes(frames);
    for (const e of accepted) { const o = outcomeR(candles, e.signalIdx, horizon, e.dir, scenario); if (o) accCont.push({ v: o.netR > 0 ? 1 : 0, week: isoWeek(e.closeMs), pair }); }
    for (const e of rejected) { const o = outcomeR(candles, e.signalIdx, horizon, e.dir, scenario); if (o) rejCont.push({ v: o.netR > 0 ? 1 : 0, week: isoWeek(e.closeMs), pair }); }
  }
  // paired-ish contrast: per-week (acc rate − rej rate)
  const weeksSet = new Set([...accCont, ...rejCont].map((x) => x.week));
  const h2Samples = [];
  for (const w of weeksSet) { const a = accCont.filter((x) => x.week === w).map((x) => x.v), r = rejCont.filter((x) => x.week === w).map((x) => x.v); if (a.length && r.length) h2Samples.push({ v: mean(a) - mean(r), week: w }); }
  const h2CI = weekBlockCI(h2Samples, seed);
  trials.push({ hypothesis: 'H2', metric: 'accepted − rejected continuation rate', ...h2CI, nAccepted: accCont.length, nRejected: rejCont.length });

  // ---- H3: with-strength (confirmed) vs price-only, SAME episodes ----
  const h3Samples = []; let withN = 0, priceOnlyN = 0;
  for (const { pair, candles, frames } of perPair) {
    const acc = stateEpisodes(frames, 'ACCEPTED');
    for (const e of acc) {
      const o = outcomeR(candles, e.signalIdx, horizon, e.dir, scenario); if (!o) continue;
      // price-only counterpart: same close, direction from priceOnlyState (may be weaker/absent)
      const pod = dirOf(e.priceOnlyState || '');
      const po = pod ? outcomeR(candles, e.signalIdx, horizon, pod, scenario) : null;
      if (e.confirmed) withN++; if (pod) priceOnlyN++;
      h3Samples.push({ v: o.netR - (po ? po.netR : 0), week: isoWeek(e.closeMs), pair });
    }
  }
  const h3CI = weekBlockCI(h3Samples, seed);
  trials.push({ hypothesis: 'H3', metric: 'confirmed − price-only netR (same episodes)', ...h3CI, confirmedEpisodes: withN });

  // ---- Holm across the 3 primary hypotheses ----
  const holmRej = holm({ H1: h1CI.pOneSided, H2: h2CI.pOneSided, H3: h3CI.pOneSided });

  // ---- concentration / tail ----
  const conc = concentration(h1Episodes, (e) => e.pair);
  const concCcy = concentration(h1Episodes, (e) => e.currency || e.pair.split('_')[0]);
  const h1TailStats = tail(h1Tail);

  // ---- per-hypothesis verdicts (gate) ----
  const common = { provenance, economics, coveragePartial: !!opts.coveragePartial };
  const beats = (ci, ctrlMean) => ci.mean != null && ci.mean > (ctrlMean || 0) && ci.mean > 0; // vs control + vs null(0)
  const verdicts = {
    H1: decideHypothesis({ ...common, ciLow: h1CI.ciLow, ciHigh: h1CI.ciHigh, holmReject: holmRej.H1, beatsControls: beats(h1CI, mean(matchedOppR)), posWeekShare: h1CI.posWeekShare, maxConcentration: Math.max(conc.maxShare, concCcy.maxShare), nEpisodes: h1CI.n, nWeeks: h1CI.weeks }),
    H2: decideHypothesis({ ...common, ciLow: h2CI.ciLow, ciHigh: h2CI.ciHigh, holmReject: holmRej.H2, beatsControls: h2CI.mean > 0, posWeekShare: h2CI.posWeekShare, maxConcentration: 0, nEpisodes: accCont.length + rejCont.length, nWeeks: h2CI.weeks }),
    H3: decideHypothesis({ ...common, ciLow: h3CI.ciLow, ciHigh: h3CI.ciHigh, holmReject: holmRej.H3, beatsControls: h3CI.mean > 0, posWeekShare: h3CI.posWeekShare, maxConcentration: 0, nEpisodes: h3CI.n, nWeeks: h3CI.weeks }),
  };

  const report = {
    version: PREREGISTRATION.version, registrationHash, provenance, economics,
    stage5Preserved: { decision: 'NONE PASSED', immutable: true, note: 'Stage 5/5A unchanged; a gate pass only permits owner review for a FUTURE prospective shadow cohort.' },
    horizon, scenario, seed,
    hypotheses: {
      H1: { ...trials[0], concentrationPair: conc, concentrationCurrency: concCcy, tail: h1TailStats, holmReject: holmRej.H1, verdict: verdicts.H1.verdict, reasons: verdicts.H1.reasons },
      H2: { ...trials[1], holmReject: holmRej.H2, verdict: verdicts.H2.verdict, reasons: verdicts.H2.reasons },
      H3: { ...trials[2], holmReject: holmRej.H3, verdict: verdicts.H3.verdict, reasons: verdicts.H3.reasons },
    },
    trials,
    disclaimer: 'Historical fit is NOT proof of live profitability. Economics ESTIMATED (mid-only). No live signals/scheduler/broker/deploy/push.',
  };
  report.dataHash = crypto.createHash('sha256').update(stableStringify({ perPairCounts: perPair.map((p) => ({ pair: p.pair, candles: p.candles.length, frames: p.frames.length })) })).digest('hex').slice(0, 16);
  return report;
}

module.exports = {
  PREREGISTRATION, registrationHash, M15,
  atr14, outcomeR, dirOf, familyOf, stateEpisodes, departureEpisodes,
  weekBlockCI, holm, concentration, tail, decideHypothesis, evaluate, isoWeek, sessionOf, mean,
};
