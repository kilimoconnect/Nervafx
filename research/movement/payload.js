'use strict';

/**
 * Dashboard payload: enriched main table for the selected window, a cross-window
 * heatmap (score + direction per currency per window), per-pair data freshness, and
 * research action states. Decision support only — never a trade signal/probability.
 */

const { computeWindow } = require('./engine');
const { enrich } = require('./analytics');
const { WINDOWS, CURRENCIES, PAIRS, M15_MS, windowByName } = require('./config');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// Research action state (movement-only; news-dependent states need the news layer).
function actionState(cu) {
  if (!cu || !cu.coverage || cu.coverage.valid < 4 || cu.direction === 'UNAVAILABLE') return { key: 'INSUFFICIENT', label: 'Insufficient data' };
  if (cu.extension && cu.extension.available && cu.extension.label === 'unusually extended') return { key: 'EXTENDED', label: 'Extended — review entry carefully' };
  if (cu.direction === 'MIXED') return { key: 'CONFLICTING', label: 'Conflicting / no clear direction' };
  if (cu.onset && cu.onset.detected) return { key: 'INVESTIGATE', label: 'Investigate movement (await fundamental + price-action evidence)' };
  return { key: 'AWAIT_SETUP', label: 'Await price-action setup' };
}

function freshness(series, asOfMs) {
  let anchor = -Infinity;
  for (const p of PAIRS) { const s = series[p]; if (s && s.ms.length) { let i = s.ms.length - 1; while (i >= 0 && s.ms[i] > asOfMs) i--; if (i >= 0 && s.ms[i] > anchor) anchor = s.ms[i]; } }
  const stale = [];
  for (const p of PAIRS) { const s = series[p]; if (!s || !s.ms.length) { stale.push(p); continue; } let i = s.ms.length - 1; while (i >= 0 && s.ms[i] > asOfMs) i--; if (i < 0 || s.ms[i] < anchor - 2 * M15_MS) stale.push(p); }
  return { latestCloseUtc: iso(isFinite(anchor) ? anchor : null), pairsTotal: PAIRS.length, pairsStale: stale, pairsFresh: PAIRS.length - stale.length };
}

function buildDashboard(series, asOfMs, selectedWindow, cfg, selectedCurrency) {
  const wname = windowByName(selectedWindow).name;
  const enriched = enrich(series, wname, cfg, asOfMs, Math.max(cfg.persistence.recentObs, 96));
  if (!enriched.ok) return { ok: false, reason: enriched.reason || 'no data' };

  // Main table (selected window).
  const table = CURRENCIES.map((c) => {
    const cu = enriched.currencies[c];
    return {
      currency: c, score: cu.score, direction: cu.direction, coverage: cu.coverage, provisional: cu.provisional,
      breadth: cu.breadth, persistence: cu.persistence, onset: cu.onset, extension: cu.extension,
      action: actionState(cu),
      contributions: cu.contributions, history: cu.history,
      limitations: ['Pairs share currencies and are correlated — breadth is not 7 independent confirmations.', 'Normalization uses a recent-window std baseline.', cu.coverage.valid < 7 ? ('Provisional: coverage ' + cu.coverage.valid + '/7 (' + cu.coverage.missing.join(', ') + ').') : null, 'Fundamental (news/expectations) confirmation UNAVAILABLE in this build.'].filter(Boolean),
    };
  });

  // Cross-window heatmap.
  const heatmap = { windows: WINDOWS.map((w) => ({ name: w.name, label: w.label })), rows: [] };
  const perWindow = {};
  for (const w of WINDOWS) perWindow[w.name] = computeWindow(series, asOfMs, w.name, cfg);
  for (const c of CURRENCIES) {
    const cells = WINDOWS.map((w) => {
      const r = perWindow[w.name]; const cu = r && r.ok ? r.currencies[c] : null;
      return cu ? { window: w.name, score: cu.score, direction: cu.direction, coverage: cu.coverage.valid + '/7', breadth: cu.breadth } : { window: w.name, score: null, direction: 'UNAVAILABLE' };
    });
    heatmap.rows.push({ currency: c, cells });
  }

  const out = {
    ok: true, version: cfg.version, timezone: 'Africa/Dar_es_Salaam',
    asOfUtc: enriched.asOfUtc, windowName: wname, windowLabel: enriched.windowLabel,
    aggregation: enriched.aggregation, observationNote: enriched.observationNote,
    windows: WINDOWS, currencies: CURRENCIES,
    freshness: freshness(series, asOfMs),
    table, heatmap,
    news: { wired: false, note: 'News/calendar & expectations layer is scaffolded but not yet populated — fundamental confirmation shows UNAVAILABLE. See docs.' },
  };

  if (selectedCurrency && enriched.currencies[selectedCurrency]) {
    const cu = enriched.currencies[selectedCurrency];
    out.detail = {
      currency: selectedCurrency, score: cu.score, direction: cu.direction, coverage: cu.coverage,
      contributions: cu.contributions, history: cu.history, persistence: cu.persistence, onset: cu.onset, extension: cu.extension,
      action: actionState(cu),
      limitations: [
        'Pairs share currencies and are correlated — breadth is not 7 independent confirmations.',
        'Normalization uses a recent-window std baseline (non-overlapping same-horizon returns).',
        cu.coverage.valid < 7 ? ('Provisional: coverage ' + cu.coverage.valid + '/7 (missing/stale: ' + cu.coverage.missing.join(', ') + ').') : null,
        'Fundamental confirmation (news/expectations) is UNAVAILABLE in this build.',
      ].filter(Boolean),
    };
  }
  return out;
}

module.exports = { buildDashboard, actionState, freshness };
