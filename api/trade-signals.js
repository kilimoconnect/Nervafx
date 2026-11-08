'use strict';

/**
 * GET /api/trade-signals — MODELLED trade-signal research (UNVALIDATED, estimated execution).
 *
 *   ?view=all|board|current|history|performance|detail   (default all)
 *   ?strategy=today|week|month
 *   ?days=90            window of history to reconstruct (cap 180)
 *   ?portfolio=indep|combined   (performance)
 *   ?key=<signal key>   (detail)
 *   history filters: ?pair= ?direction=BUY|SELL ?status= ?origin= ?result=win|loss
 *
 * Computes live from candles (cached per window, short TTL). Not a broker; places no orders.
 */

const { getClient, cors } = require('./_db');
const { computeSnapshot, findDetail } = require('../research/signals/service');
const { STRATEGY_KEYS } = require('../research/signals/config');

const DAY = 24 * 60 * 60 * 1000;
const TTL_MS = 10 * 60 * 1000;      // reuse a computed snapshot for 10 minutes (warm instance)
let CACHE = {};                     // { [days]: { at, snapshot } }

async function getSnapshot(sb, days) {
  const now = Date.now();
  const hit = CACHE[days];
  if (hit && now - hit.at < TTL_MS) return hit.snapshot;
  const fromIso = new Date(now - days * DAY).toISOString();
  const snapshot = await computeSnapshot(sb, { strategies: STRATEGY_KEYS, fromIso });
  CACHE[days] = { at: now, snapshot };
  return snapshot;
}

function stratSummary(s) {
  if (!s || !s.ok) return { ok: false, reason: s && s.reason };
  return {
    ok: true, label: s.label, version: s.version, confirmTf: s.confirmTf, entryTf: s.entryTf,
    lastAsOf: s.lastAsOf, board: s.board, current: s.current, stats: s.stats,
    portfolio: { accountReturnPct: s.portfolio.accountReturnPct, maxDrawdownPct: s.portfolio.maxDrawdownPct, closed: s.portfolio.closed, openAtEnd: s.portfolio.openAtEnd, finalEquity: s.portfolio.finalEquity },
    monthly: s.reports.monthly,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};
    const view = q.view || 'all';
    const days = Math.min(180, Math.max(14, parseInt(q.days, 10) || 90));
    const sb = getClient();
    const snap = await getSnapshot(sb, days);
    const base = { ok: true, generatedAt: snap.generatedAt, window: snap.window, params: snap.params, disclaimer: snap.disclaimer };

    if (view === 'all') {
      const strategies = {};
      for (const k of STRATEGY_KEYS) strategies[k] = stratSummary(snap.strategies[k]);
      return res.json(Object.assign(base, { view, strategies, combined: snap.combined, combinedNote: snap.combinedNote }));
    }

    const key = q.strategy && STRATEGY_KEYS.includes(q.strategy) ? q.strategy : 'today';
    const s = snap.strategies[key];
    if (!s || !s.ok) return res.json(Object.assign(base, { view, strategy: key, ok: true, available: false, reason: s && s.reason }));

    if (view === 'board') return res.json(Object.assign(base, { view, strategy: key, board: s.board }));
    if (view === 'current') return res.json(Object.assign(base, { view, strategy: key, current: s.current }));

    if (view === 'history') {
      let rows = s.history;
      if (q.pair) rows = rows.filter((r) => r.pair === q.pair.toUpperCase());
      if (q.direction) rows = rows.filter((r) => r.direction === q.direction.toUpperCase());
      if (q.status) rows = rows.filter((r) => r.status === q.status.toUpperCase());
      if (q.origin) rows = rows.filter((r) => (r.origin || 'historical') === q.origin);
      if (q.result) rows = rows.filter((r) => r.result === q.result);
      rows = rows.slice().sort((a, b) => b.publishedAtMs - a.publishedAtMs);
      return res.json(Object.assign(base, { view, strategy: key, count: rows.length, history: rows }));
    }

    if (view === 'detail') {
      const d = findDetail(s.rawTrades || [], q.key || '');
      if (!d) return res.status(404).json(Object.assign(base, { view, ok: false, error: 'signal not found in current window' }));
      return res.json(Object.assign(base, { view, strategy: key, detail: d }));
    }

    if (view === 'performance') {
      const portfolio = q.portfolio === 'combined' ? snap.combined : s.portfolio;
      return res.json(Object.assign(base, {
        view, strategy: key, portfolioKind: q.portfolio === 'combined' ? 'combined' : 'independent',
        stats: s.stats, reports: s.reports, byPair: s.byPair, byDirection: s.byDirection, byRank: s.byRank, byOrigin: s.byOrigin,
        portfolio, combinedNote: q.portfolio === 'combined' ? snap.combinedNote : null,
      }));
    }

    return res.status(400).json(Object.assign(base, { ok: false, error: 'unknown view' }));
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 300;
