'use strict';

/**
 * Assemble the Currency Comparison payload for one view (previousDay | todaySoFar |
 * sessions). For each of the 8 currencies it returns the HIGHLIGHTED index candle plus
 * two faded context candles, candle metrics, breadth from actual oriented pair returns,
 * and an open-relative mini-chart path on a shared % scale. Research / pair-selection
 * only — NO execution, buy/sell signal, probability, or opaque combined score.
 *
 * Index extremes are sampled at the M15 construction resolution (disclosed). Missing or
 * incomplete inputs are reported as such — never substituted with zero.
 */

const { buildIndices } = require('./index-build');
const { periodCandle, candleMetrics, periodPath, breadth } = require('./candles');
const { completedDays, todaySoFar, completedSessions } = require('./periods');
const { CURRENCIES, sessionByName, DAY_MS, M15_MS } = require('./config');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
/** HH:MM wall-clock in a named timezone (EAT display = Africa/Nairobi, UTC+3, DST-free). */
function hhmm(ms, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  return f.format(new Date(ms));
}
const EAT = 'Africa/Nairobi';

function periodsForView(view, session, asOfMs, lastDataMs) {
  if (view === 'previousDay') return { periods: completedDays(asOfMs, lastDataMs, 3), kind: 'day' };
  if (view === 'todaySoFar') return { periods: todaySoFar(asOfMs, lastDataMs, 2), kind: 'developing' };
  if (view === 'sessions') return { periods: completedSessions(session || 'london', asOfMs, lastDataMs, 3), kind: 'session' };
  return { periods: [], kind: null };
}

function periodInfo(view, session, highlight, kind) {
  const endEat = hhmm(highlight.endMs, EAT), endUtc = hhmm(highlight.endMs, 'UTC');
  const dateIso = new Date(highlight.startMs).toISOString().slice(0, 10);
  if (view === 'todaySoFar') {
    return {
      title: 'Today so far — through ' + endEat + ' EAT (' + endUtc + ' UTC)',
      sublabel: 'Closed inputs · Developing day', status: 'developing',
      startUtc: iso(highlight.startMs), endUtc: iso(highlight.endMs),
      note: 'Developing UTC day through the latest COMPLETED M15 close; the forming candle is excluded.',
    };
  }
  if (view === 'sessions') {
    const s = sessionByName(session || 'london');
    return {
      title: s.label + ' session — ' + dateIso,
      sublabel: 'Latest completed occurrence · ' + s.tz + ' (DST-aware)', status: 'completed',
      startUtc: iso(highlight.startMs), endUtc: iso(highlight.endMs),
      note: 'Local ' + s.startHour + ':00–' + s.endHour + ':00 ' + s.tz + ', converted to UTC per-instant (DST-aware).',
    };
  }
  return {
    title: 'Previous day — ' + dateIso, sublabel: 'Closed UTC trading day', status: 'completed',
    startUtc: iso(highlight.startMs), endUtc: iso(highlight.endMs),
    note: 'Completed UTC calendar day 00:00→00:00.',
  };
}

function candleSet(built, ccy, periods, cfg) {
  return periods.map((p) => {
    const c = periodCandle(built, ccy, p.startMs, p.endMs);
    if (!c.ok) return { ok: false, reason: c.reason, startUtc: iso(p.startMs), endUtc: iso(p.endMs), status: p.status };
    return { ok: true, startUtc: iso(p.startMs), endUtc: iso(p.endMs), status: p.status, resolution: c.resolution, nPoints: c.nPoints, ohlc: { open: c.open, high: c.high, low: c.low, close: c.close }, metrics: candleMetrics(c, cfg) };
  });
}

function buildComparison(candlesByPair, args, cfg) {
  const asOfMs = args.asOfMs, view = args.view || 'previousDay', session = args.session || null, selected = args.currency || null;
  const built = buildIndices(candlesByPair);
  if (!built.ok) return { ok: false, available: false, reason: built.reason || 'insufficient synchronized candles' };

  const lastDataMs = built.lastMs;
  const { periods, kind } = periodsForView(view, session, Math.min(asOfMs, lastDataMs), lastDataMs);
  if (!periods.length) return { ok: false, available: false, reason: 'no completed period for this view yet', firstDataUtc: iso(built.firstMs), lastDataUtc: iso(lastDataMs) };

  const hi = periods[periods.length - 1];            // highlighted period
  const ctx = periods.slice(0, periods.length - 1);  // up to 2 faded context periods

  // Per-currency: highlight candle + context candles + metrics + breadth + mini path.
  const cards = CURRENCIES.map((c) => {
    const set = candleSet(built, c, periods, cfg);
    const highlight = set[set.length - 1];
    const context = set.slice(0, set.length - 1);
    const path = periodPath(built, c, hi.startMs, hi.endMs);
    const bd = breadth(c, candlesByPair, hi.startMs, hi.endMs, cfg);
    return {
      currency: c,
      available: highlight.ok,
      highlight, context,
      returnPct: highlight.ok ? highlight.metrics.returnPct : null,
      direction: highlight.ok ? highlight.metrics.direction : 'unavailable',
      mini: { ok: path.ok, points: path.points },
      breadth: { appreciated: bd.appreciated, depreciated: bd.depreciated, unchanged: bd.unchanged, coverage: bd.coverage, provisional: bd.provisional },
    };
  });

  // Rank by signed return of the highlighted candle; unavailable currencies sink to the end.
  const ranked = cards.slice().sort((a, b) => {
    if (a.returnPct == null && b.returnPct == null) return 0;
    if (a.returnPct == null) return 1;
    if (b.returnPct == null) return -1;
    return b.returnPct - a.returnPct;
  });
  ranked.forEach((c, i) => { c.rank = c.returnPct == null ? null : i + 1; });

  // Shared % scale across all mini-charts (open-relative).
  let lo = 0, hi2 = 0;
  for (const c of cards) for (const p of c.mini.points) { if (p.pct < lo) lo = p.pct; if (p.pct > hi2) hi2 = p.pct; }

  const availN = cards.filter((c) => c.available).length;
  const anyProvisional = cards.some((c) => c.breadth.provisional);
  const staleMs = Math.min(asOfMs, Date.now()) - lastDataMs;

  const out = {
    ok: true, available: availN > 0, demo: false, version: cfg.version,
    view, kind, session: view === 'sessions' ? sessionByName(session || 'london').name : null,
    sessionsAvailable: require('./config').SESSIONS.map((s) => ({ name: s.name, label: s.label, tz: s.tz })),
    asOfUtc: iso(asOfMs), firstDataUtc: iso(built.firstMs), lastDataUtc: iso(lastDataMs),
    resolution: built.resolution, resolutionNote: 'Index OHLC sampled at M15 construction resolution — intrabar synthetic highs/lows are not claimed.',
    tradingDay: cfg.tradingDay,
    periodInfo: periodInfo(view, session, hi, kind),
    contextPeriods: ctx.map((p) => ({ startUtc: iso(p.startMs), endUtc: iso(p.endMs), label: p.label, status: p.status })),
    currencies: CURRENCIES,
    cards: ranked,
    sharedScale: { minPct: +lo.toFixed(4), maxPct: +hi2.toFixed(4) },
    quality: {
      currenciesAvailable: availN, currenciesTotal: CURRENCIES.length,
      provisionalBreadth: anyProvisional, stale: staleMs > 2 * M15_MS, staleByMs: staleMs > 0 ? staleMs : 0,
      gaps: built.gaps.length,
    },
    limitations: [
      'Relative indices only: each currency is measured against the equally-weighted 8-currency basket, not an absolute value.',
      'Index highs/lows are sampled at M15 — true intrabar extremes of the simultaneous basket path are not recoverable from pair OHLC.',
      'Breadth legs share currencies and are correlated — not 7 independent confirmations.',
      'Research / pair-selection tool. No execution, buy/sell signal, probability, or profitability claim.',
    ],
  };

  if (selected && CURRENCIES.indexOf(selected) >= 0) {
    const card = cards.find((c) => c.currency === selected);
    const bd = breadth(selected, candlesByPair, hi.startMs, hi.endMs, cfg);
    out.detail = {
      currency: selected, available: card.available,
      highlight: card.highlight, context: card.context, mini: card.mini,
      pairs: bd.per,         // the 7 underlying counterpart legs (oriented returns + classification)
      coverage: bd.coverage,
      note: 'Underlying legs are oriented to ' + selected + ' (base → +, quote → −). Classification tolerance is a research default.',
    };
  }
  return out;
}

module.exports = { buildComparison, periodsForView, periodInfo };
