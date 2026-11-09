'use strict';

/**
 * Today-so-far PERCENTAGE EVOLUTION (research, UNVALIDATED).
 *
 * Each currency's zero-sum 1/8 index is expressed as an open-relative % from the start of the
 * developing EAT day (00:00 EAT). This module returns:
 *   - liveEvolution: the intraday % path for all 8 currencies through the latest completed M15,
 *     with the peak/trough reached and whether it crossed the ±threshold ("best movement"), and
 *   - historyScan: across past EAT days, how often each currency reached ±threshold at ANY point
 *     in the day (peak ≥ +t or trough ≤ −t), plus a per-day matrix for a heatmap.
 *
 * "Best movement" = the % reaching +0.25% or beyond, or −0.25% or beyond (configurable). This is
 * a relative-movement observation, NOT a signal, probability, or profitability claim.
 */

const { periodPath } = require('./candles');
const { dayStart } = require('./periods');
const { CURRENCIES } = require('./config');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLD = 0.25;   // percent
const r4 = (x) => (x == null ? null : +(+x).toFixed(4));

/** Peak / trough / current of a % path (points: [{ms,pct}], pct relative to day open = 0). */
function pathExtremes(points) {
  let peak = 0, trough = 0, cur = 0, peakMs = null, troughMs = null, upMs = null, downMs = null;
  for (const p of points) {
    if (p.pct > peak) { peak = p.pct; peakMs = p.ms; }
    if (p.pct < trough) { trough = p.pct; troughMs = p.ms; }
    cur = p.pct;
  }
  return { peak, trough, cur, peakMs, troughMs };
}
/** First time the path reaches +thr (up) and −thr (down), if ever. */
function firstCrossings(points, thr) {
  let upMs = null, downMs = null;
  for (const p of points) {
    if (upMs == null && p.pct >= thr) upMs = p.ms;
    if (downMs == null && p.pct <= -thr) downMs = p.ms;
    if (upMs != null && downMs != null) break;
  }
  return { upMs, downMs };
}

/**
 * Live developing-day evolution for all currencies.
 *   built: buildIndices(...) output; asOfMs: decision cutoff; lastDataMs: built.lastMs.
 */
function liveEvolution(built, asOfMs, lastDataMs, threshold = DEFAULT_THRESHOLD) {
  const cutoff = Math.min(asOfMs, lastDataMs == null ? asOfMs : lastDataMs);
  const startMs = dayStart(cutoff);
  const rows = CURRENCIES.map((ccy) => {
    const path = periodPath(built, ccy, startMs, cutoff);
    const pts = (path.points || []).map((p) => ({ ms: p.ms, pct: r4(p.pct) }));
    const ex = pathExtremes(path.points || []);
    const cr = firstCrossings(path.points || [], threshold);
    const reachedUp = ex.peak >= threshold, reachedDown = ex.trough <= -threshold;
    const state = ex.cur >= threshold ? 'above' : (ex.cur <= -threshold ? 'below' : 'within');
    return {
      currency: ccy, ok: !!path.ok, points: pts,
      current: r4(ex.cur), peak: r4(ex.peak), trough: r4(ex.trough),
      peakMs: ex.peakMs, troughMs: ex.troughMs,
      reachedUp, reachedDown, reachedEither: reachedUp || reachedDown,
      firstUpMs: cr.upMs, firstDownMs: cr.downMs, state,
    };
  });
  // Rank by current % (desc); unavailable sink to the end.
  const ranked = rows.slice().sort((a, b) => {
    if (!a.ok && !b.ok) return 0; if (!a.ok) return 1; if (!b.ok) return -1;
    return b.current - a.current;
  });
  ranked.forEach((rrow, i) => { rrow.rank = rrow.ok ? i + 1 : null; });
  return { startMs, cutoffMs: cutoff, threshold, rows: ranked };
}

/**
 * Historical scan across EAT days in the loaded window: per-currency frequency of reaching
 * ±threshold at any point in the day, plus a per-day matrix (most recent first, bounded).
 */
function historyScan(built, asOfMs, lastDataMs, { threshold = DEFAULT_THRESHOLD, matrixDays = 60 } = {}) {
  const cutoff = Math.min(asOfMs, lastDataMs == null ? asOfMs : lastDataMs);
  const firstDay = dayStart(built.firstMs);
  const lastDay = dayStart(cutoff);

  const agg = {}; for (const c of CURRENCIES) agg[c] = { currency: c, daysComplete: 0, daysUp: 0, daysDown: 0, daysEither: 0, maxUp: 0, maxDown: 0, sumPeakAbs: 0 };
  const matrix = [];   // one row per day with data

  for (let d = firstDay; d <= lastDay; d += DAY_MS) {
    const dEnd = Math.min(d + DAY_MS, cutoff);
    const cells = []; let anyData = false;
    for (const ccy of CURRENCIES) {
      const path = periodPath(built, ccy, d, dEnd);
      if (!path.ok) { cells.push(null); continue; }
      anyData = true;
      const ex = pathExtremes(path.points);
      const up = ex.peak >= threshold, down = ex.trough <= -threshold;
      const a = agg[ccy];
      a.daysComplete++; if (up) a.daysUp++; if (down) a.daysDown++; if (up || down) a.daysEither++;
      if (ex.peak > a.maxUp) a.maxUp = ex.peak; if (ex.trough < a.maxDown) a.maxDown = ex.trough;
      a.sumPeakAbs += Math.max(ex.peak, -ex.trough);
      cells.push({ u: up, d: down, peak: r4(ex.peak), trough: r4(ex.trough) });
    }
    if (anyData) matrix.push({ dayMs: d, cells });
  }

  const perCurrency = CURRENCIES.map((c) => {
    const a = agg[c], n = a.daysComplete || 1;
    return {
      currency: c, daysComplete: a.daysComplete,
      daysUp: a.daysUp, daysDown: a.daysDown, daysEither: a.daysEither,
      upPct: +(100 * a.daysUp / n).toFixed(1), downPct: +(100 * a.daysDown / n).toFixed(1),
      eitherPct: +(100 * a.daysEither / n).toFixed(1),
      maxUp: r4(a.maxUp), maxDown: r4(a.maxDown), avgPeakAbs: r4(a.sumPeakAbs / n),
    };
  });

  const recent = matrix.slice(-matrixDays).reverse();   // most recent first
  return { threshold, daysScanned: matrix.length, currencies: CURRENCIES, perCurrency, matrix: recent };
}

module.exports = { liveEvolution, historyScan, pathExtremes, firstCrossings, DEFAULT_THRESHOLD };
