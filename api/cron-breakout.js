'use strict';

/**
 * GET /api/cron-breakout — live forward processing for the Breakout module.
 *
 * Each run, per strategy: advance from the stored cursor over newly-closed trigger candles,
 * recompute strength/qualification AT each close with the SAME engine the dashboard uses,
 * and persist any NEW signals (immutable), plus refresh the higher-TF pair states and a
 * decision snapshot. Idempotent — deterministic signal ids + a chronological cursor mean a
 * re-run (e.g. after an outage) neither duplicates signals nor rewrites published rows.
 *
 * Signals only (research, UNVALIDATED). No broker orders. A trigger close is a reference
 * price, not a fill. Auth: Vercel Cron header or CRON_SECRET bearer token. Skips the FX close.
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

function isMarketOpen() {
  const now = new Date(), day = now.getUTCDay(), hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 21) return false;
  if (day === 5 && hour >= 21) return false;
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!verifyCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  if (!isMarketOpen() && !force) return res.json({ ok: true, skipped: true, reason: 'market closed' });

  const only = req.query && req.query.strategy;
  const keys = only ? [only].filter((k) => STRATEGY_KEYS.includes(k)) : STRATEGY_KEYS;
  if (!keys.length) return res.status(400).json({ ok: false, error: 'unknown strategy' });

  const sb = getDB();
  const t0 = Date.now();
  const out = {};
  let errors = 0;

  for (const key of keys) {
    if (Date.now() - t0 > 270000) { out[key] = { ok: false, reason: 'deadline' }; break; }
    try {
      out[key] = await persistRange(sb, key, { origin: 'forward', advanceCursor: true });
      if (!out[key].ok) errors++;
    } catch (e) {
      errors++;
      out[key] = { ok: false, error: String(e.message || e) };
      console.error('[cron-breakout]', key, e.message || e);
    }
  }

  res.json({
    ok: errors === 0, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    note: 'Breakout research signals (EAT-aligned, UNVALIDATED). Signals only — no orders, stops, targets or profitability claims.',
    strategies: out,
  });
};

module.exports.maxDuration = 300;
