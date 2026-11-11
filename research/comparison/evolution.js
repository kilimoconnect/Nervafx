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

const { periodPath, breadth } = require('./candles');
const { idxAtOrBefore } = require('./index-build');
const { dayStart } = require('./periods');
const { CURRENCIES } = require('./config');
const { movementMetrics, paceChange } = require('./movement');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLD = 0.25;   // percent — "best movement" (single currency)
const DEFAULT_SPREAD = 0.30;      // percent — "spreading apart" (strongest − weakest)
// A period defines the developing window the evolution is measured over: start(ms) → period open,
// step = fixed length for the history scan. Default = the EAT day; the H4 view passes h4Start/H4_MS.
const DEFAULT_PERIOD = { start: dayStart, step: DAY_MS };
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
function windowCandleEvolution(built, windows, emaPeriod = EMA_PERIOD, moveThreshold = DEFAULT_THRESHOLD, periodStart = dayStart) {
  const alpha = 2 / (emaPeriod + 1);
  return (windows || []).map((w) => {
    const dayOpenMs = periodStart(w.startMs);   // baseline strength at the PERIOD open (day or H4)
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
function liveEvolution(built, asOfMs, lastDataMs, threshold = DEFAULT_THRESHOLD, spreadThreshold = DEFAULT_SPREAD, period = DEFAULT_PERIOD) {
  const cutoff = Math.min(asOfMs, lastDataMs == null ? asOfMs : lastDataMs);
  const startMs = period.start(cutoff);
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
  const candleWindows = windowCandleEvolution(built, spread.windows, EMA_PERIOD, threshold, period.start);   // strength + 0.25% moves inside each >threshold window
  return { startMs, cutoffMs: cutoff, threshold, rows: ranked, spread, candleWindows };
}

/**
 * Historical scan across EAT days in the loaded window: per-currency frequency of reaching
 * ±threshold at any point in the day, plus a per-day matrix (most recent first, bounded).
 */
function historyScan(built, asOfMs, lastDataMs, { threshold = DEFAULT_THRESHOLD, spreadThreshold = DEFAULT_SPREAD, matrixDays = 60, period = DEFAULT_PERIOD } = {}) {
  const cutoff = Math.min(asOfMs, lastDataMs == null ? asOfMs : lastDataMs);
  const firstDay = period.start(built.firstMs);
  const lastDay = period.start(cutoff);
  const step = period.step;

  const agg = {}; for (const c of CURRENCIES) agg[c] = { currency: c, daysComplete: 0, daysUp: 0, daysDown: 0, daysEither: 0, maxUp: 0, maxDown: 0, sumPeakAbs: 0 };
  const matrix = [];           // one row per period-bucket with data
  const onsets = [];           // first spread-onset minutes into the bucket, for buckets that spread apart
  const episodeCounts = [];    // number of qualifying episodes per bucket

  for (let d = firstDay; d <= lastDay; d += step) {
    const dEnd = Math.min(d + step, cutoff);
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

// ── Movement-QUALITY table (research, descriptive) ──────────────────────────────────────────────
// Three windows over the SAME observed index series the chart uses: Today so far (day open→cutoff),
// Last 4 hours (16 M15 intervals), Last 1 hour (4 M15 intervals). Each window's per-currency series
// is the CONTINUOUS index rebased to the window's first completed close (x[i]=100·(idx[i]/idx[win0]−1),
// in pp), so rolling windows reconstruct continuously across midnight and never bridge a market gap.
const WINDOW_INTERVALS = { h4: 16, h1: 4 };

/** True iff every step from startPos+1..endPos is exactly one base interval apart (no bridged gap). */
function contiguity(built, startPos, endPos) {
  const tl = built.timeline; let gaps = 0, maxGapMs = 0;
  for (let i = startPos + 1; i <= endPos; i++) { const d = tl[i] - tl[i - 1]; if (d !== built.baseMs) { gaps++; if (d > maxGapMs) maxGapMs = d; } }
  return { contiguous: gaps === 0, gaps, maxGapMs };
}

/** Per-currency level series (pp) over [startPos, endPos], rebased to the window open. */
function seriesFor(built, ccy, startPos, endPos) {
  const base = built.index[ccy][startPos]; const xs = [], times = [];
  for (let i = startPos; i <= endPos; i++) { xs.push(100 * (built.index[ccy][i] / base - 1)); times.push(built.timeline[i]); }
  return { xs, times };
}

/** Resolve a window's start position + coverage (shared across currencies — the timeline is common). */
function resolveWindow(built, endPos, kind, dayOpenPos) {
  let startPos, prevStartPos = null, prevEndPos = null, shortSample = false, label;
  if (kind === 'today') { startPos = dayOpenPos; label = 'Today so far'; }
  else { const k = WINDOW_INTERVALS[kind]; startPos = endPos - k; prevStartPos = endPos - 2 * k; prevEndPos = endPos - k; shortSample = kind === 'h1'; label = kind === 'h4' ? 'Last 4 hours' : 'Last 1 hour'; }
  const cov = { kind, label, shortSample, prevStartPos, prevEndPos };
  if (startPos == null || startPos < 0 || endPos <= startPos) { cov.available = false; cov.reason = 'insufficient history'; cov.intervals = 0; cov.startPos = startPos; return cov; }
  const ct = contiguity(built, startPos, endPos);
  cov.startPos = startPos; cov.intervals = endPos - startPos; cov.gaps = ct.gaps; cov.maxGapMs = ct.maxGapMs;
  cov.startMs = built.timeline[startPos]; cov.endMs = built.timeline[endPos];
  cov.incomplete = !ct.contiguous;
  // rolling windows REQUIRE a complete contiguous span; today is inherently variable but flags gaps.
  cov.available = (kind === 'today') ? true : ct.contiguous;
  if (!cov.available) cov.reason = 'incomplete coverage — market gap in window';
  return cov;
}

/**
 * Per-currency movement-quality across the three windows, plus a dispersion summary.
 *   built: buildIndices output (continuous index); byPair: raw pair candles (for breadth); cutoff: ms.
 * Returns { tol, windows, perCurrency:[{currency, dailyPerf, today, h4, h1}], dispersion }.
 */
function movementTable(built, byPair, cutoff, { tol = 0.005, cfg = null, periodStart = dayStart } = {}) {
  const anchor = idxAtOrBefore(built, CURRENCIES[0], cutoff);
  if (!anchor) return { ok: false, reason: 'no data at cutoff' };
  const endPos = anchor.idx;
  const dayOpenMs = periodStart(cutoff);
  const dayOpenAt = idxAtOrBefore(built, CURRENCIES[0], dayOpenMs);
  const dayOpenPos = dayOpenAt ? dayOpenAt.idx : null;
  const kinds = ['today', 'h4', 'h1'];
  const windows = {}; for (const k of kinds) windows[k] = resolveWindow(built, endPos, k, dayOpenPos);

  const perCurrency = CURRENCIES.map((ccy) => {
    const out = { currency: ccy };
    out.dailyPerf = (dayOpenPos != null) ? r4(100 * (built.index[ccy][endPos] / built.index[ccy][dayOpenPos] - 1)) : null;
    for (const k of kinds) {
      const w = windows[k];
      if (!w.available) { out[k] = { ok: false, reason: w.reason || 'unavailable', coverage: coverageOf(w) }; continue; }
      const ser = seriesFor(built, ccy, w.startPos, endPos);
      const m = movementMetrics(ser.xs, ser.times, tol);
      if (byPair && cfg) m.breadth = breadth(ccy, byPair, w.startMs, w.endMs, cfg);
      if (w.prevStartPos != null) {
        m.paceChange = (w.prevStartPos >= 0 && contiguity(built, w.prevStartPos, w.prevEndPos).contiguous)
          ? paceChange(m.pace, movementMetrics(seriesFor(built, ccy, w.prevStartPos, w.prevEndPos).xs, seriesFor(built, ccy, w.prevStartPos, w.prevEndPos).times, tol).pace)
          : null;
      }
      m.coverage = coverageOf(w);
      out[k] = m;
    }
    return out;
  });

  // dispersion summary (strongest − weakest, from the same open-relative spread series)
  const sseries = spreadSeries(built, dayOpenMs, cutoff);
  const spts = sseries.points || [];
  const last = spts.length ? spts[spts.length - 1] : null;
  let maxS = 0, maxMs = null; for (const p of spts) if (p.spread > maxS) { maxS = p.spread; maxMs = p.ms; }
  const spreadAtPos = (pos) => { if (pos == null || pos < 0) return null; const ms = built.timeline[pos]; let best = null; for (const p of spts) { if (p.ms <= ms) best = p; else break; } return best ? best.spread : null; };
  // dispersion at a window start; the day open is definitionally 0 (all currencies at 0% there).
  const change = {}; for (const k of kinds) { const w = windows[k]; const sp = !w.available ? null : (w.startPos === dayOpenPos ? 0 : spreadAtPos(w.startPos)); change[k] = (last && sp != null) ? r4(last.spread - sp) : null; }
  const dispersion = {
    current: last ? r4(last.spread) : null, strongest: last ? last.topCcy : null, weakest: last ? last.bottomCcy : null,
    strongestPct: last ? r4(last.top) : null, weakestPct: last ? r4(last.bottom) : null,
    maxToday: r4(maxS), maxMs, change,
  };

  const windowsOut = {}; for (const k of kinds) windowsOut[k] = coverageOf(windows[k]);
  return { tol, endMs: built.timeline[endPos], dayOpenMs, windows: windowsOut, perCurrency, dispersion };
}

/** Public view of a resolved window (no internal positions). */
function coverageOf(w) {
  return { kind: w.kind, label: w.label, shortSample: !!w.shortSample, available: !!w.available, incomplete: !!w.incomplete, reason: w.reason || null, intervals: w.intervals || 0, startMs: w.startMs || null, endMs: w.endMs || null, gaps: w.gaps || 0, maxGapMs: w.maxGapMs || 0 };
}

/**
 * Optional two-currency INDEX-SPREAD analysis: spreadAB[t] = pctA − pctB (both rebased to the window
 * open). Movement-quality on that spread for the three windows. This is the index spread, NOT a
 * tradable pair return unless the methodology mathematically supports that equivalence.
 */
function spreadAnalysis(built, A, B, cutoff, { tol = 0.005, periodStart = dayStart } = {}) {
  if (!CURRENCIES.includes(A) || !CURRENCIES.includes(B) || A === B) return { ok: false, reason: 'pick two distinct currencies' };
  const anchor = idxAtOrBefore(built, A, cutoff); if (!anchor) return { ok: false, reason: 'no data at cutoff' };
  const endPos = anchor.idx;
  const o = idxAtOrBefore(built, A, periodStart(cutoff)); const dayOpenPos = o ? o.idx : null;
  const kinds = ['today', 'h4', 'h1'];
  const windows = {};
  for (const k of kinds) {
    const w = resolveWindow(built, endPos, k, dayOpenPos);
    if (!w.available) { windows[k] = { ok: false, reason: w.reason || 'unavailable', coverage: coverageOf(w) }; continue; }
    const baseA = built.index[A][w.startPos], baseB = built.index[B][w.startPos]; const xs = [], times = [];
    for (let i = w.startPos; i <= endPos; i++) { xs.push(100 * (built.index[A][i] / baseA - 1) - 100 * (built.index[B][i] / baseB - 1)); times.push(built.timeline[i]); }
    const m = movementMetrics(xs, times, tol); m.coverage = coverageOf(w); windows[k] = m;
  }
  return { ok: true, a: A, b: B, label: A + ' − ' + B + ' index spread', windows };
}

module.exports = { liveEvolution, historyScan, spreadSeries, spreadInfo, windowCandleEvolution, pathExtremes, firstCrossings, movementTable, spreadAnalysis, DEFAULT_THRESHOLD, DEFAULT_SPREAD };
