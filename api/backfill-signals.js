'use strict';

/**
 * GET /api/backfill-signals?strategy=today[&from=ISO][&to=ISO]
 *
 * Chunked HISTORICAL backfill of the trade-signal tables (spec §9). Replays one strategy
 * over a window using the SAME causal engine as the live cron, persisting immutable signals,
 * lifecycle events and outcomes. Idempotent — safe to re-run and to resume after a timeout.
 *
 * Because a full ~18-month replay can exceed the 300s function budget, run it a window at a
 * time (e.g. month by month) and watch the returned counts; re-running an already-done window
 * is a no-op. `origin` is recorded as 'historical' to keep backfilled signals distinguishable
 * from the live forward feed.
 *
 * MODELLED / estimated execution. No broker orders. Auth: Vercel Cron header or CRON_SECRET.
 */

const { createClient } = require('@supabase/supabase-js');
const { runPersist } = require('../src/signalEngine');
const { STRATEGY_KEYS } = require('../research/signals/config');

function verifyCron(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  return !!(process.env.CRON_SECRET && auth === process.env.CRON_SECRET);
}
function getDB() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY); }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!verifyCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  const q = req.query || {};
  const key = q.strategy;
  if (!STRATEGY_KEYS.includes(key)) {
    return res.status(400).json({ ok: false, error: 'strategy must be one of ' + STRATEGY_KEYS.join(', ') });
  }
  const fromIso = q.from ? new Date(q.from).toISOString() : undefined;
  const toIso = q.to ? new Date(q.to).toISOString() : undefined;

  const sb = getDB();
  const t0 = Date.now();
  try {
    const r = await runPersist(sb, key, { origin: 'historical', fromIso, toIso });
    res.json({
      ok: r.ok, strategy: key, window: r.window, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
      grid: r.grid, lastAsOf: r.lastAsOf, persisted: r.persisted, summary: r.summary, reason: r.reason,
      note: 'MODELLED / estimated execution, UNVALIDATED. Re-run is idempotent. No broker orders.',
    });
  } catch (e) {
    console.error('[backfill-signals]', key, e.message || e);
    res.status(500).json({ ok: false, strategy: key, error: String(e.message || e) });
  }
};

module.exports.maxDuration = 300;
