'use strict';

/**
 * M15 Strategy Research — time-respecting walk-forward comparison (Stage 5). Pure.
 *
 * Candidates are already FROZEN (Stage 3), so evaluation is out-of-sample by
 * construction. Where a variant must be SELECTED, we select on the CALIBRATION
 * (earlier) split and report the EVALUATION (later) split — never the reverse.
 * Uncertainty uses BLOCK (week) resampling so dependence across days and shared
 * currencies is preserved (no naive independent-candle SE). Verdicts are
 * SELECT_FOR_SHADOW | REJECT | INSUFFICIENT_EVIDENCE — never PROVEN_PROFITABLE.
 */

const filled = (r) => r.label === 'FILLED' && r.netR && r.netR.typical != null;
function weekKey(ms) { const d = new Date(ms); const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1); const wk = Math.floor((ms - jan1) / (7 * 864e5)); return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`; }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

/** Split by date into calibration (earlier `fraction`) and evaluation (later), with an embargo gap. */
function splitTrainEval(records, opts = {}) {
  const frac = opts.fraction || 0.5;
  const times = records.map((r) => r.signalMs).sort((a, b) => a - b);
  if (!times.length) return { boundaryMs: null, train: [], evalR: [] };
  const boundaryMs = times[Math.floor(times.length * frac)];
  const embargo = opts.embargoMs || 4 * 15 * 60 * 1000;         // 1h embargo across the boundary
  const train = records.filter((r) => r.signalMs < boundaryMs - embargo);
  const evalR = records.filter((r) => r.signalMs >= boundaryMs + embargo);
  return { boundaryMs, train, evalR };
}

/** Block (week) bootstrap CI for the mean of netR.typical. Preserves within-week dependence. */
function blockBootstrapCI(records, opts = {}) {
  const rs = records.filter(filled); const iters = opts.iters || 2000; const alpha = opts.alpha || 0.05;
  if (rs.length < 8) return { n: rs.length, mean: mean(rs.map((r) => r.netR.typical)), ciLow: null, ciHigh: null, note: 'too few' };
  const byWeek = {}; for (const r of rs) (byWeek[weekKey(r.signalMs)] = byWeek[weekKey(r.signalMs)] || []).push(r.netR.typical);
  const weeks = Object.keys(byWeek); const means = [];
  let seed = opts.seed || 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    const pool = [];
    for (let k = 0; k < weeks.length; k++) pool.push(...byWeek[weeks[Math.floor(rnd() * weeks.length)]]);
    means.push(mean(pool));
  }
  means.sort((a, b) => a - b);
  return { n: rs.length, weeks: weeks.length, mean: +mean(rs.map((r) => r.netR.typical)).toFixed(3),
    ciLow: +means[Math.floor(alpha / 2 * iters)].toFixed(3), ciHigh: +means[Math.floor((1 - alpha / 2) * iters)].toFixed(3) };
}

/** Per-fold (weekly) mean netR + positive-fold share. */
function foldByWeek(records) {
  const rs = records.filter(filled); const byWeek = {};
  for (const r of rs) (byWeek[weekKey(r.signalMs)] = byWeek[weekKey(r.signalMs)] || []).push(r.netR.typical);
  const folds = Object.keys(byWeek).sort().map((w) => ({ week: w, n: byWeek[w].length, meanNetR: +mean(byWeek[w]).toFixed(3) }));
  const pos = folds.filter((f) => f.meanNetR > 0).length;
  return { folds, positiveFoldShare: folds.length ? +(pos / folds.length).toFixed(3) : null };
}

/** Incremental effect of an addition vs the baseline, on matched episodes. */
function compareIncremental(baseRecs, addRecs) {
  const key = (r) => `${r.pair}|${r.signalMs}|${r.direction}`;
  const baseMap = new Map(baseRecs.map((r) => [key(r), r]));
  const addMap = new Map(addRecs.map((r) => [key(r), r]));
  const shared = addRecs.filter((r) => baseMap.has(key(r)));
  const removed = baseRecs.filter((r) => !addMap.has(key(r)));            // baseline episodes the gate removed
  const added = addRecs.filter((r) => !baseMap.has(key(r)));             // truly new episodes
  const sf = shared.filter(filled), bf = baseRecs.filter(filled);
  return {
    baselineEpisodes: baseRecs.length, addEpisodes: addRecs.length,
    sharedFilled: sf.length, removed: removed.length, added: added.length,
    baselineMeanNetR: bf.length ? +mean(bf.map((r) => r.netR.typical)).toFixed(3) : null,
    addMeanNetR: addRecs.filter(filled).length ? +mean(addRecs.filter(filled).map((r) => r.netR.typical)).toFixed(3) : null,
    meanNetR_onShared_add: sf.length ? +mean(sf.map((r) => r.netR.typical)).toFixed(3) : null,
  };
}

/** Currency-cluster concentration: max share of filled episodes touching one currency. */
function clusterConcentration(records) {
  const rs = records.filter(filled); if (!rs.length) return null;
  const c = {}; for (const r of rs) { c[r.base] = (c[r.base] || 0) + 1; c[r.quote] = (c[r.quote] || 0) + 1; }
  return +(Math.max(...Object.values(c)) / rs.length).toFixed(3);
}

/**
 * Documented decision standard. A candidate must show positive OOS net economics
 * (CI low > 0), a gain over the simpler baseline, fold stability (not one period),
 * acceptable adverse outcomes, and no single-currency dependence — else it is
 * REJECT or INSUFFICIENT_EVIDENCE. Never PROVEN_PROFITABLE.
 */
function decide(s, opts = {}) {
  const minN = opts.minEpisodes || 30;
  const reasons = [];
  if (s.evalCI.n < minN) { reasons.push(`too few OOS episodes (${s.evalCI.n} < ${minN})`); return { verdict: 'INSUFFICIENT_EVIDENCE', reasons }; }
  if (s.evalCI.ciLow == null) { reasons.push('CI unavailable (too few blocks)'); return { verdict: 'INSUFFICIENT_EVIDENCE', reasons }; }
  // Clearly negative out-of-sample (whole CI below 0) ⇒ REJECT, whatever a worse control does.
  if (s.evalCI.ciHigh < 0) { reasons.push(`OOS net R CI entirely below 0 [${s.evalCI.ciLow}, ${s.evalCI.ciHigh}]`); return { verdict: 'REJECT', reasons }; }
  const positiveOOS = s.evalCI.ciLow > 0;
  const beatsBaseline = s.evalMeanNetR != null && s.baselineEvalMeanNetR != null && s.evalMeanNetR > s.baselineEvalMeanNetR;
  const beatsControl = s.evalMeanNetR != null && s.controlEvalMeanNetR != null && s.evalMeanNetR > s.controlEvalMeanNetR;
  const stable = s.positiveFoldShare != null && s.positiveFoldShare >= 0.6;
  const notConcentrated = s.clusterConcentration != null && s.clusterConcentration <= 0.5;
  if (positiveOOS && beatsBaseline && beatsControl && stable && notConcentrated) return { verdict: 'SELECT_FOR_SHADOW', reasons: ['positive OOS net economics (CI>0), beats baseline+control, stable across folds, not concentrated'] };
  if (!positiveOOS) reasons.push(`OOS net R CI includes 0 [${s.evalCI.ciLow}, ${s.evalCI.ciHigh}]`);
  if (!beatsBaseline) reasons.push('no gain over the simpler baseline');
  if (!beatsControl) reasons.push('does not beat the pseudo-random control');
  if (!stable) reasons.push(`unstable across folds (positive-fold share ${s.positiveFoldShare})`);
  if (!notConcentrated) reasons.push(`concentrated in one currency (${s.clusterConcentration})`);
  return { verdict: 'INSUFFICIENT_EVIDENCE', reasons };
}

module.exports = { filled, weekKey, splitTrainEval, blockBootstrapCI, foldByWeek, compareIncremental, clusterConcentration, decide, mean };
