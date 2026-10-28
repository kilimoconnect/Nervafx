'use strict';

/**
 * Currency Movement engine (deterministic, causal, explainable). See config.js.
 *
 * Windows are measured in TRADING time (N completed M15 candles), which equals clock
 * time during continuous trading and compresses across weekend/holiday closures; the
 * ACTUAL start/end timestamps are always returned so the real elapsed span is visible.
 * Completed candles only; no forward-fill; no future information.
 */

const { M15_MS, CURRENCIES, PAIRS, pairsForCurrency, windowByName } = require('./config');

/** Build per-pair close-time/close-price series (ascending). ms = candle CLOSE time. */
function buildSeries(candlesByPair) {
  const s = {};
  for (const p of Object.keys(candlesByPair)) {
    const cs = (candlesByPair[p] || []).slice().sort((a, b) => a.openMs - b.openMs);
    s[p] = { ms: cs.map((c) => c.openMs + M15_MS), close: cs.map((c) => +c.close) };
  }
  return s;
}

/** Last index whose close time ≤ t (binary search); −1 if none. */
function idxAtOrBefore(series, t) {
  const a = series.ms; let lo = 0, hi = a.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

const logret = (endClose, startClose) => Math.log(endClose / startClose);

/**
 * Rolling std of NON-OVERLAPPING same-horizon (candle-count) returns ending at or
 * before `startIdx` (i.e. strictly before the measured window's forward movement).
 */
function rollingStd(series, startIdx, candles, cfg) {
  const rs = [];
  for (let k = 0; k < cfg.norm.maxSamples; k++) {
    const ei = startIdx - k * candles, si = ei - candles;
    if (si < 0) break;
    const r = logret(series.close[ei], series.close[si]);
    if (isFinite(r)) rs.push(r);
  }
  if (rs.length < cfg.norm.minSamples) return { ok: false, n: rs.length, reason: 'insufficient history' };
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const varr = rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rs.length - 1);
  const std = Math.sqrt(varr);
  if (!(std > 0)) return { ok: false, n: rs.length, reason: 'zero variance' };
  return { ok: true, std, n: rs.length };
}

/** Per-pair measured return + normalization for a window ending at asOfMs. */
function pairMeasure(series, asOfMs, window, cfg) {
  if (!series || !series.ms.length) return { ok: false, reason: 'no data' };
  const endIdx = idxAtOrBefore(series, asOfMs);
  if (endIdx < 0) return { ok: false, reason: 'no data' };
  const startIdx = endIdx - window.candles;
  if (startIdx < 0) return { ok: false, reason: 'insufficient history' };
  const ret = logret(series.close[endIdx], series.close[startIdx]);
  const norm = rollingStd(series, startIdx, window.candles, cfg);
  return {
    ok: true, ret: +ret.toFixed(8),
    startMs: series.ms[startIdx], endMs: series.ms[endIdx],
    startClose: series.close[startIdx], endClose: series.close[endIdx],
    normalized: norm.ok ? +(ret / norm.std).toFixed(4) : null,
    normStd: norm.ok ? +norm.std.toFixed(8) : null, normN: norm.n,
    insufficient: !norm.ok, insufficientReason: norm.ok ? null : norm.reason,
  };
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * Compute the full per-currency movement result for one window, as-of asOfMs.
 * Pure: `series` is the pre-built per-pair series.
 */
function computeWindow(series, asOfMs, windowName, cfg) {
  const window = windowByName(windowName);
  // Common analysis timestamp = the LATEST completed M15 close ≤ asOfMs that any pair
  // reached. Pairs whose latest close lags it by more than `tol` are STALE → missing
  // (never dragged into the anchor, never treated as neutral).
  let anchor = -Infinity;
  for (const p of PAIRS) { const s = series[p]; if (s && s.ms.length) { const i = idxAtOrBefore(s, asOfMs); if (i >= 0 && s.ms[i] > anchor) anchor = s.ms[i]; } }
  if (!isFinite(anchor)) return { ok: false, reason: 'no data', windowName };
  const tol = 2 * M15_MS;

  const pm = {};
  let spanStart = null;
  for (const p of PAIRS) {
    const m = pairMeasure(series[p], anchor, window, cfg);
    if (m.ok && m.endMs < anchor - tol) { m.ok = false; m.stale = true; m.reason = 'stale'; }
    pm[p] = m;
    if (m.ok && (spanStart == null || m.startMs > spanStart)) spanStart = m.startMs;
  }

  const currencies = {};
  for (const ccy of CURRENCIES) {
    const legs = pairsForCurrency(ccy);
    const contributions = [], valid = [], missing = [];
    for (const leg of legs) {
      const m = pm[leg.pair];
      if (!m || !m.ok || m.insufficient) { missing.push(leg.pair); contributions.push({ pair: leg.pair, role: leg.role, other: leg.other, ret: m && m.ok ? m.ret : null, normalized: null, contribution: null, insufficient: true, reason: (m && (m.insufficientReason || m.reason)) || 'no data' }); continue; }
      const sign = leg.role === 'base' ? 1 : -1;
      const contribution = +(sign * m.normalized).toFixed(4);
      contributions.push({ pair: leg.pair, role: leg.role, other: leg.other, ret: m.ret, normalized: m.normalized, contribution, insufficient: false });
      valid.push(contribution);
    }
    const coverage = { valid: valid.length, total: 7, missing };
    const score = valid.length ? +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(4) : null;
    const band = cfg.neutralBand;
    const direction = score == null ? 'UNAVAILABLE' : (score > band ? 'STRENGTHENING' : score < -band ? 'WEAKENING' : 'MIXED');
    const bb = cfg.breadthNeutral;
    let str = 0, weak = 0, neu = 0;
    for (const c of valid) { if (c > bb) str++; else if (c < -bb) weak++; else neu++; }
    currencies[ccy] = {
      score, direction, coverage,
      provisional: coverage.valid < 7,
      breadth: { strengthening: str, weakening: weak, neutral: neu },
      contributions,
    };
  }

  return {
    ok: true, version: cfg.version, windowName: window.name, windowLabel: window.label, kind: window.kind,
    asOfUtc: iso(anchor), startUtc: iso(spanStart), endUtc: iso(anchor),
    aggregation: 'score = mean of the 7 signed, std-normalized pair contributions (equal weights). +base / −quote.',
    currencies,
  };
}

module.exports = { buildSeries, idxAtOrBefore, logret, rollingStd, pairMeasure, computeWindow };
