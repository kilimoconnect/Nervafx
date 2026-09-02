'use strict';

/**
 * GET /api/structure-continuation-engine
 *
 * Read-only History / Market-Replay + backtest API for the deterministic
 * D1–H4–H1 Structure Continuation System. Analytical only — never places or
 * modifies orders (History Mode is order-disabled by construction).
 *
 *   ?pair=EUR_USD&at=ISO&timezone=…            → historical replay view (default)
 *   ?mode=backtest&pair=&from=&to=[&outFrom=&outTo=][&filters]  → backtest + performance
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { fetchClosed } = require('./_cme-data');
const { buildHistoryView, snapToCompletedH1 } = require('./_scs-history');
const { runBacktest } = require('./_scs-backtest');
const { applyFilters } = require('./_scs-filters');
const { computePerformance } = require('./_scs-performance');
const { CONFIG } = require('./_scs-config');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_TZ = CONFIG.displayTzDefault;

async function h1For(sb, pair, anchorMs, limit) {
  const r = await fetchClosed(sb, pair, 'H1', anchorMs, HOUR_MS, Math.min(2000, Math.max(120, limit)));
  return r.candles;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    if (!req._internal) {
      const gate = await requirePlan(sb, req, 'premium');
      if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    }
    const q = req.query || {};
    const tz = q.timezone || DEFAULT_TZ;
    const pair = q.pair || 'EUR_USD';

    if (q.mode === 'backtest') {
      const from = new Date(q.from).getTime(), to = new Date(q.to).getTime();
      if (isNaN(from) || isNaN(to) || from >= to) return res.status(400).json({ error: 'from/to required (from < to)' });
      const bars = Math.round((to - from) / HOUR_MS) + 400;                 // window + warm-up
      const h1raw = await h1For(sb, pair, to, bars);
      const outSample = q.outFrom && q.outTo ? { from: new Date(q.outFrom).toISOString(), to: new Date(q.outTo).toISOString() } : null;
      const bt = runBacktest({ pairs: { [pair]: h1raw }, inSample: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, outSample, spread: q.spread ? +q.spread : undefined, slippage: q.slippage ? +q.slippage : undefined });

      // Optional filters over in-sample signals.
      const f = {
        pair: q.fPair, direction: q.direction, d1Direction: q.d1Direction, impulseOrigin: q.origin,
        entry: q.entry, targetReached: q.target === '1', stopReached: q.stop === '1', rejected: q.rejected === '1',
        rejectionReason: q.rejectionReason, versions: q.versions ? String(q.versions).split(',') : undefined,
      };
      const filtered = applyFilters(bt.inSample.signals, f);
      return res.json({ ok: true, pair, config: bt.config, inSample: { ...bt.inSample, filtered: filtered.signals, performance: computePerformance(filtered.signals, {}) }, outSample: bt.outSample || null, versionsAvailable: filtered.versionsAvailable });
    }

    // Default: point-in-time historical replay view.
    const at = q.at ? new Date(q.at).getTime() : Date.now();
    if (isNaN(at)) return res.status(400).json({ error: 'invalid ?at timestamp' });
    const evalMs = snapToCompletedH1(at);
    const h1raw = await h1For(sb, pair, evalMs, 700);   // ~29 trading days of H1 for D1 structure + warm-up
    if (!h1raw.length) return res.json({ ok: true, empty: true, reason: 'no candle data', pair, evalIso: new Date(evalMs).toISOString() });
    const view = buildHistoryView({ h1raw, pair, at, tz, spread: q.spread ? +q.spread : undefined });
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    return res.json(view);
  } catch (e) {
    console.error('[structure-continuation-engine]', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 120;
