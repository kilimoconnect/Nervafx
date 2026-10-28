'use strict';

/**
 * Persistence, causal onset and extension for the Currency Movement engine. These
 * recompute the per-currency score at successive COMPLETED M15 closes for the same
 * selected horizon. Overlapping windows are correlated — N observations are NOT N
 * independent signals (stated in the UI).
 */

const { computeWindow } = require('./engine');
const { M15_MS, CURRENCIES } = require('./config');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const dirSign = (d) => (d === 'STRENGTHENING' ? 1 : d === 'WEAKENING' ? -1 : 0);

/**
 * Observation series at the last `count` completed M15 closes (oldest→newest), per
 * currency: { ms, score, direction, support } where support = breadth count in the
 * score's direction. Causal: each uses only data ≤ its own timestamp.
 */
function observations(series, windowName, cfg, asOfMs, count) {
  // anchor the newest observation to the common latest close.
  const latest = computeWindow(series, asOfMs, windowName, cfg);
  if (!latest.ok) return null;
  const anchorMs = Date.parse(latest.endUtc);
  const obs = {}; for (const c of CURRENCIES) obs[c] = [];
  for (let k = count - 1; k >= 0; k--) {
    const r = computeWindow(series, anchorMs - k * M15_MS, windowName, cfg);
    if (!r.ok) continue;
    const ms = Date.parse(r.endUtc);
    for (const c of CURRENCIES) {
      const cu = r.currencies[c];
      const support = cu.direction === 'STRENGTHENING' ? cu.breadth.strengthening : cu.direction === 'WEAKENING' ? cu.breadth.weakening : 0;
      obs[c].push({ ms, score: cu.score, direction: cu.direction, support, coverageValid: cu.coverage.valid });
    }
  }
  return { anchorMs, obs };
}

/** Consecutive same-direction count, supporting/total, and breadth trend. */
function persistence(series, cfg) {
  const n = series.length; if (!n) return { consecutive: 0, supporting: 0, total: 0, breadthTrend: 'n/a' };
  const last = series[n - 1], d = last.direction;
  let consecutive = 0; for (let i = n - 1; i >= 0 && series[i].direction === d && d !== 'MIXED' && d !== 'UNAVAILABLE'; i--) consecutive++;
  const supporting = series.filter((o) => o.direction === d).length;
  // breadth trend: compare mean support over the recent half vs the earlier half.
  const half = Math.floor(n / 2);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b.support, 0) / arr.length : 0);
  const early = mean(series.slice(0, half)), recent = mean(series.slice(half));
  const breadthTrend = recent > early + 0.5 ? 'expanding' : recent < early - 0.5 ? 'contracting' : 'stable';
  return { consecutive, supporting, total: n, direction: d, breadthTrend, breadthFrom: +early.toFixed(1), breadthTo: +recent.toFixed(1) };
}

/**
 * Causal onset under the configured rule. Walk oldest→newest; a qualifying obs needs
 * |score| ≥ scoreMin, support ≥ breadthMin and the same direction held for ≥ persistMin
 * consecutive obs. firstMs = first obs of the current qualifying run; confirmedMs = the
 * obs at which confirmation first became POSSIBLE (persistMin reached + thresholds met).
 * Never backdates confirmation before it was possible.
 */
function onset(series, cfg, anchorMs) {
  const o = cfg.onset;
  const latest = series[series.length - 1];
  if (!latest || dirSign(latest.direction) === 0) return { detected: false, reason: 'no qualifying directional episode now' };
  const d = latest.direction;
  // start of the CURRENT directional run
  let i = series.length - 1; while (i >= 0 && series[i].direction === d) i--;
  const curFirstMs = series[i + 1].ms;
  // the first obs within the run where confirmation became possible (thresholds + persistMin)
  let curConfirmed = null, run2 = 0;
  for (let j = i + 1; j < series.length; j++) { run2++; const s = series[j]; if (Math.abs(s.score) >= o.scoreMin && s.support >= o.breadthMin && run2 >= o.persistMin) { curConfirmed = s.ms; break; } }
  if (curConfirmed == null) return { detected: false, reason: 'current run has not met the onset rule', direction: d, firstUtc: iso(curFirstMs) };
  return {
    detected: true, direction: d,
    firstUtc: iso(curFirstMs), confirmedUtc: iso(curConfirmed),
    ageMs: anchorMs - curConfirmed, ageBars: Math.round((anchorMs - curConfirmed) / M15_MS),
    note: 'detected onset under the selected rule — not the exact moment the market began changing its mind',
  };
}

/** Extension: |score| percentile vs the observed history (recent-window baseline). */
function extension(series, cfg) {
  const vals = series.map((o) => (o.score == null ? null : Math.abs(o.score))).filter((v) => v != null);
  if (vals.length < cfg.norm.minSamples) return { available: false, reason: 'insufficient comparable history' };
  const cur = vals[vals.length - 1];
  const below = vals.filter((v) => v <= cur).length;
  const pct = below / vals.length;
  const label = pct >= cfg.extension.extreme ? 'unusually extended' : pct >= cfg.extension.elevated ? 'elevated' : 'within usual range';
  return { available: true, magnitudePercentile: +pct.toFixed(3), label, sampleN: vals.length, basis: 'recent-window baseline (observed |score| distribution)' };
}

/** Enrich a computeWindow result with persistence/onset/extension per currency. */
function enrich(series, windowName, cfg, asOfMs, lookback) {
  const base = computeWindow(series, asOfMs, windowName, cfg);
  if (!base.ok) return base;
  const count = lookback || Math.max(cfg.persistence.recentObs, 96);
  const ob = observations(series, windowName, cfg, asOfMs, count);
  for (const c of CURRENCIES) {
    const s = ob ? ob.obs[c] : [];
    const recent = s.slice(-cfg.persistence.recentObs);
    base.currencies[c].persistence = persistence(recent, cfg);
    base.currencies[c].onset = onset(s, cfg, ob.anchorMs);
    base.currencies[c].extension = extension(s, cfg);
    base.currencies[c].history = s.map((o) => ({ t: o.ms, score: o.score, support: o.support }));
  }
  base.observationNote = 'Overlapping windows are correlated; consecutive observations are not independent confirmations.';
  return base;
}

module.exports = { observations, persistence, onset, extension, enrich };
