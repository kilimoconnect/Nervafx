'use strict';

/**
 * NervaFX Inverted Flow — data coverage (read from the actual data, never hard-coded).
 * Summarises the usable observation range + gaps so the UI can disclose exactly what it is drawing.
 */

/** Coverage for a single candle series (ascending [{openMs, ...}]). `resMs` = candle interval. */
function coverageForCandles(candles, resMs, resolution) {
  const cs = candles || [];
  if (!cs.length) return { ok: false, resolution: resolution || null, nObs: 0 };
  const first = cs[0].openMs != null ? cs[0].openMs : Date.parse(cs[0].time);
  const last = cs[cs.length - 1].openMs != null ? cs[cs.length - 1].openMs : Date.parse(cs[cs.length - 1].time);
  const gaps = [];
  for (let i = 1; i < cs.length; i++) {
    const a = cs[i - 1].openMs != null ? cs[i - 1].openMs : Date.parse(cs[i - 1].time);
    const b = cs[i].openMs != null ? cs[i].openMs : Date.parse(cs[i].time);
    if (resMs && (b - a) > resMs * 1.5) gaps.push({ fromMs: a + resMs, toMs: b, ms: b - a });
  }
  return { ok: true, resolution: resolution || null, nObs: cs.length, firstMs: first, lastMs: last + (resMs || 0), gaps };
}

/** Coverage for the synchronized index timeline (from buildIndices). */
function coverageForIndex(built) {
  if (!built || !built.ok) return { ok: false, reason: (built && built.reason) || 'no index' };
  return {
    ok: true, resolution: built.resolution, nObs: built.nSteps,
    firstMs: built.firstMs, lastMs: built.lastMs, gaps: built.gaps || [],
  };
}

module.exports = { coverageForCandles, coverageForIndex };
