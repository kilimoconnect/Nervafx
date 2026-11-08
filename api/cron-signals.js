'use strict';

/**
 * GET /api/cron-signals
 *
 * Live forward feed for the trade-signal module (spec §9). Each run, per strategy:
 *   1. load a bounded recent window of base candles,
 *   2. reconstruct the period comparison → top-3 → confirm → trigger (strictly causal),
 *   3. publish any NEW signals (immutable), and
 *   4. advance still-OPEN trades toward CLOSED by re-monitoring on M5 (else M15).
 *
 * Everything is idempotent: signal ids are deterministic, published rows are insert-once,
 * events are append-only, and the outcome projection is upserted. Re-running the same window
 * (e.g. after an outage) neither duplicates signals nor rewrites resolved trades. Expired
 * reconstructed signals are never re-advertised as actionable — they persist as EXPIRED.
 *
 * MODELLED / estimated execution (mid-price history, no bid/ask). No broker orders.
 *
 * Auth: Vercel Cron header or CRON_SECRET bearer token. Skips the weekend FX close.
 */

const { createClient } = require('@supabase/supabase-js');
const { runPersist } = require('../src/signalEngine');
const { STRATEGY_KEYS } = require('../research/signals/config');

function verifyCron(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  return !!(process.env.CRON_SECRET && auth === process.env.CRON_SECRET);
}

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

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

  // Market-closed skip, but allow ?force=1 for manual catch-up after an outage.
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  if (!isMarketOpen() && !force) {
    return res.json({ ok: true, skipped: true, reason: 'market closed' });
  }

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
      const r = await runPersist(sb, key, { origin: 'forward' });
      out[key] = r.ok
        ? { ok: true, grid: r.grid, lastAsOf: r.lastAsOf, persisted: r.persisted, summary: r.summary }
        : { ok: false, reason: r.reason };
      if (!r.ok) errors++;
    } catch (e) {
      errors++;
      out[key] = { ok: false, error: String(e.message || e) };
      console.error('[cron-signals]', key, e.message || e);
    }
  }

  res.json({
    ok: errors === 0, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    note: 'MODELLED research signals — estimated execution, UNVALIDATED. No broker orders.',
    strategies: out,
  });
};

module.exports.maxDuration = 300;
