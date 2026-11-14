'use strict';

/**
 * GET /api/backfill-breakout?strategy=daily[&from=ISO][&to=ISO]
 *
 * Chunked HISTORICAL reconstruction of the Breakout tables. Replays one strategy over a
 * window with the SAME causal engine as the live cron, persisting immutable signals (origin
 * 'historical') plus the pair-states/snapshot at the window end. Idempotent — deterministic
 * ids make a re-run a no-op — and it does NOT advance the live forward cursor, so historical
 * backfill behind the cursor never interferes with live processing.
 *
 * A full replay can exceed the 300s budget on the thinner strategies, so run it a window at a
 * time and watch the returned counts. Results are a historical reconstruction from stored
 * candles — not proof of what the live feed delivered at the time.
 *
 * Auth: Vercel Cron header or CRON_SECRET bearer token.
 */

const { createClient } = require('@supabase/supabase-js');
const { persistRange } = require('../research/breakout/service');
const { STRATEGY_KEYS } = require('../research/breakout/config');

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
  const fromMs = q.from ? Date.parse(q.from) : null;
  const toMs = q.to ? Date.parse(q.to) : null;
  if (q.from && isNaN(fromMs)) return res.status(400).json({ ok: false, error: 'bad from' });
  if (q.to && isNaN(toMs)) return res.status(400).json({ ok: false, error: 'bad to' });

  const sb = getDB();
  const t0 = Date.now();
  try {
    const r = await persistRange(sb, key, { origin: 'historical', fromMs: fromMs == null ? 0 : fromMs, toMs, advanceCursor: false });
    res.json({
      ...r, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
      note: 'Historical reconstruction (EAT-aligned, UNVALIDATED). Re-run is idempotent; does not touch the live cursor. Signals only.',
    });
  } catch (e) {
    console.error('[backfill-breakout]', key, e.message || e);
    res.status(500).json({ ok: false, strategy: key, error: String(e.message || e) });
  }
};

module.exports.maxDuration = 300;
