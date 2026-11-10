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
const { idxAtOrBefore } = require('./index-build');
const { dayStart } = require('./periods');
const { CURRENCIES } = require('./config');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLD = 0.25;   // percent — "best movement" (single currency)
const DEFAULT_SPREAD = 0.30;      // percent — "spreading apart" (strongest − weakest)
const r4 = (x) => (x == null ? null : +(+x).toFixed(4));

/**
 * Dispersion series for a day: at each M15 step, the spread = strongest − weakest currency %
 * (both open-relative to the same 00:00-EAT open). "Spreading apart" = this spread widening;
 * the watch onset is the first step the spread reaches `spreadThreshold`.
 */
function spreadSeries(built, startMs, endMs) {
  const open0 = idxAtOrBefore(built, CURRENCIES[0], startMs);
  if (!open0) return { ok: false, points: [] };
  const openIdx = open0.idx;
  const O = {}; for (const c of CURRENCIES) O[c] = built.index[c][openIdx];
  const tl = built.timeline, pts = [];
  for (let i = openIdx + 1; i < tl.length && tl[i] <= endMs; i++) {
    let top = -Infinity, bot = Infinity, topC = null, botC = null;
    for (const c of CURRENCIES) { const v = 100 * (built.index[c][i] / O[c] - 1); if (v > top) { top = v; topC = c; } if (v < bot) { bot = v; botC = c; } }
    pts.push({ ms: tl[i], spread: top - bot, top, bottom: bot, topCcy: topC, bottomCcy: botC });
  }
  return { ok: pts.length > 0, openMs: startMs, points: pts };
}

/**
 * Summarise a spread series. "Spreading apart" QUALIFIES at a step only when the spread reaches
 * `threshold` AND at least one currency is itself beyond ±`bestThreshold` (a real best movement) —
 * a tight cluster drifting apart without a leader crossing ±0.25% does not count.
 *
 * Dispersion is not a one-shot: currencies spread apart, bunch back, and spread again. So we return
 * every qualifying EPISODE as a {startMs, endMs, ongoing, peak…} window, not just the first onset.
 * `watchMs`/`watchMinutes` keep the first onset (for the primary marker); `windows` is the full set.
 */
function spreadInfo(series, threshold, startMs, bestThreshold = DEFAULT_THRESHOLD) {
  const pts = series.points || [];
  const minOf = (ms) => Math.round((ms - startMs) / 60000);
  let max = 0, maxMs = null, cur = 0, curQual = false;
  const out = [], windows = [];
  let open = null;   // the episode currently being accumulated
  for (const p of pts) {
    const qual = p.spread >= threshold && (p.top >= bestThreshold || p.bottom <= -bestThreshold);
    if (p.spread > max) { max = p.spread; maxMs = p.ms; }
    if (qual) {
      if (!open) open = { startMs: p.ms, endMs: p.ms, peak: p.spread, peakMs: p.ms, topCcy: p.topCcy, bottomCcy: p.bottomCcy };
      open.endMs = p.ms;
      if (p.spread > open.peak) { open.peak = p.spread; open.peakMs = p.ms; open.topCcy = p.topCcy; open.bottomCcy = p.bottomCcy; }
    } else if (open) {
      windows.push(open); open = null;
    }
    cur = p.spread; curQual = qual;
    out.push({ ms: p.ms, spread: r4(p.spread), top: r4(p.top), bottom: r4(p.bottom), topCcy: p.topCcy, bottomCcy: p.bottomCcy, qual });
  }
  if (open) { open.ongoing = true; windows.push(open); }   // still spreading apart at the cutoff

  const wins = windows.map((w) => ({
    startMs: w.startMs, endMs: w.endMs, ongoing: !!w.ongoing,
    startMin: minOf(w.startMs), endMin: minOf(w.endMs), durationMin: minOf(w.endMs) - minOf(w.startMs),
    peak: r4(w.peak), peakMs: w.peakMs, topCcy: w.topCcy, bottomCcy: w.bottomCcy,
  }));
  const watchMs = wins.length ? wins[0].startMs : null;
  return {
    threshold, bestThreshold, current: r4(cur), max: r4(max), maxMs,
    watchMs, watchMinutes: watchMs == null ? null : minOf(watchMs),
    episodes: wins.length, windows: wins,
    state: curQual ? 'watching' : 'bunched',
    series: out,
  };
}

const EMA_PERIOD = 5;     // M15 periods — smooths the currency-strength reading
const SLOPE_LOOKBACK = 3; // M15 steps (~45 min) over which EMA slope is measured for momentum

/**
 * CURRENCY STRENGTH OVER TIME WHILE dispersion is above threshold (inside each qualifying "watch"
 * window). Resolution is M15: each currency's strength is the 10-period EMA of its % move since the
 * 00:00-EAT DAY OPEN (not the window open), so the lines are a real strength level rather than all
 * forced to 0 at the window start. The EMA is seeded from the day open and warmed through the steps
 * before the window; only the steps inside the window are returned for display. Returns, per window,
 * each currency's M15 strength line, plus a snapshot ranking strongest→weakest at the latest close.
 * Relative-movement research, UNVALIDATED.
 */
function windowCandleEvolution(built, windows, emaPeriod = EMA_PERIOD, moveThreshold = DEFAULT_THRESHOLD) {
  const alpha = 2 / (emaPeriod + 1);
  return (windows || []).map((w) => {
    const dayOpenMs = dayStart(w.startMs);
    const o = idxAtOrBefore(built, CURRENCIES[0], dayOpenMs);
    const s = idxAtOrBefore(built, CURRENCIES[0], w.startMs);
    const e = idxAtOrBefore(built, CURRENCIES[0], w.endMs);
    const base = { startMs: w.startMs, endMs: w.endMs, ongoing: !!w.ongoing, resolution: 'M15', emaPeriod, moveThreshold, nSteps: 0, times: [], lines: [], strength: [] };
    if (!o || !s || !e || e.idx < s.idx) return base;
    const openPos = o.idx, startPos = s.idx, endPos = e.idx;
    const openV = {}; const emaPrev = {}; const series = {};
    // per-currency move trackers (over the window only): peak/trough from open, and the biggest
    // pullback from a running high and bounce from a running low — the "0.25% move off an extreme".
    const mv = {};
    for (const c of CURRENCIES) { openV[c] = built.index[c][openPos]; series[c] = []; mv[c] = { peak: -Infinity, trough: Infinity, peakMs: null, troughMs: null, runMax: -Infinity, runMin: Infinity, pullback: 0, pullbackMs: null, bounce: 0, bounceMs: null }; }

    const times = [];
    for (let i = openPos; i <= endPos; i++) {           // walk from the day open so the EMA is warmed
      const inWin = i >= startPos;
      const ms = built.timeline[i];
      if (inWin) times.push(ms);
      for (const c of CURRENCIES) {
        const pct = 100 * (built.index[c][i] / openV[c] - 1);   // % since 00:00 EAT day open
        emaPrev[c] = (emaPrev[c] == null) ? pct : emaPrev[c] + alpha * (pct - emaPrev[c]);
        if (!inWin) continue;
        const v = emaPrev[c]; series[c].push(r4(v));
        const m = mv[c];
        if (v > m.peak) { m.peak = v; m.peakMs = ms; }
        if (v < m.trough) { m.trough = v; m.troughMs = ms; }
        if (v > m.runMax) m.runMax = v;
        if (v < m.runMin) m.runMin = v;
        if (m.runMax - v > m.pullback) { m.pullback = m.runMax - v; m.pullbackMs = ms; }   // move down off a high
        if (v - m.runMin > m.bounce) { m.bounce = v - m.runMin; m.bounceMs = ms; }         // move up off a low
      }
    }
    const lines = CURRENCIES.map((c) => ({ currency: c, ema: series[c], last: series[c][series[c].length - 1] }));
    const strength = CURRENCIES.map((c) => {
      const m = mv[c];
      const arr = series[c], n = arr.length, v = emaPrev[c];
      const slope = n > 1 ? v - arr[Math.max(0, n - 1 - SLOPE_LOOKBACK)] : 0;   // EMA direction over ~45 min
      const rising = slope > 0, falling = slope < 0;
      // a currency qualifies only when its EMA momentum confirms its side:
      // strong (positive) AND still rising, or weak (negative) AND still falling.
      const qualifies = (v >= 0 && rising) || (v < 0 && falling);
      return {
        currency: c,
        strength: r4(v),                                               // EMA(10) strength (vs day open) at latest close
        raw: r4(100 * (built.index[c][endPos] / openV[c] - 1)),        // unsmoothed % vs day open, for reference
        slope: r4(slope), rising, falling, qualifies,
        peak: r4(m.peak), trough: r4(m.trough), peakMs: m.peakMs, troughMs: m.troughMs,
        pullback: r4(m.pullback), pullbackMs: m.pullbackMs, bounce: r4(m.bounce), bounceMs: m.bounceMs,
        reachedUp: m.peak >= moveThreshold, reachedDown: m.trough <= -moveThreshold,   // 0.25% from open
        pulledBack: m.pullback >= moveThreshold, bounced: m.bounce >= moveThreshold,   // 0.25% off an extreme
      };
    }).sort((a, b) => b.strength - a.strength);
    strength.forEach((r, k) => { r.rank = k + 1; });
    return { startMs: w.startMs, endMs: w.endMs, ongoing: !!w.ongoing, resolution: 'M15', emaPeriod, moveThreshold, nSteps: times.length, times, lines, strength };
  });
}

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
function liveEvolution(built, asOfMs, lastDataMs, threshold = DEFAULT_THRESHOLD, spreadThreshold = DEFAULT_SPREAD) {
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
  const spread = spreadInfo(spreadSeries(built, startMs, cutoff), spreadThreshold, startMs, threshold);
  const candleWindows = windowCandleEvolution(built, spread.windows, EMA_PERIOD, threshold);   // strength + 0.25% moves inside each >threshold window
  return { startMs, cutoffMs: cutoff, threshold, rows: ranked, spread, candleWindows };
}

/**
 * Historical scan across EAT days in the loaded window: per-currency frequency of reaching
 * ±threshold at any point in the day, plus a per-day matrix (most recent first, bounded).
 */
function historyScan(built, asOfMs, lastDataMs, { threshold = DEFAULT_THRESHOLD, spreadThreshold = DEFAULT_SPREAD, matrixDays = 60 } = {}) {
  const cutoff = Math.min(asOfMs, lastDataMs == null ? asOfMs : lastDataMs);
  const firstDay = dayStart(built.firstMs);
  const lastDay = dayStart(cutoff);

  const agg = {}; for (const c of CURRENCIES) agg[c] = { currency: c, daysComplete: 0, daysUp: 0, daysDown: 0, daysEither: 0, maxUp: 0, maxDown: 0, sumPeakAbs: 0 };
  const matrix = [];           // one row per day with data
  const onsets = [];           // first spread-onset minutes-into-day, for days that spread apart
  const episodeCounts = [];    // number of qualifying episodes per day

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
    if (!anyData) continue;
    const sp = spreadInfo(spreadSeries(built, d, dEnd), spreadThreshold, d, threshold);
    if (sp.watchMinutes != null) onsets.push(sp.watchMinutes);
    episodeCounts.push(sp.episodes);
    matrix.push({ dayMs: d, cells, maxSpread: sp.max, watchMinutes: sp.watchMinutes, episodes: sp.episodes });
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

  const sorted = onsets.slice().sort((x, y) => x - y);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const totalEpisodes = episodeCounts.reduce((s, n) => s + n, 0);
  const spreadSummary = {
    threshold: spreadThreshold, daysComplete: matrix.length, daysSpread: onsets.length,
    spreadPct: matrix.length ? +(100 * onsets.length / matrix.length).toFixed(1) : null,
    medianOnsetMin: median, earliestOnsetMin: sorted.length ? sorted[0] : null, latestOnsetMin: sorted.length ? sorted[sorted.length - 1] : null,
    totalEpisodes, avgEpisodesPerSpreadDay: onsets.length ? +(totalEpisodes / onsets.length).toFixed(2) : null,
  };

  const recent = matrix.slice(-matrixDays).reverse();   // most recent first
  return { threshold, spreadThreshold, daysScanned: matrix.length, currencies: CURRENCIES, perCurrency, spreadSummary, matrix: recent };
}

module.exports = { liveEvolution, historyScan, spreadSeries, spreadInfo, windowCandleEvolution, pathExtremes, firstCrossings, DEFAULT_THRESHOLD, DEFAULT_SPREAD };
