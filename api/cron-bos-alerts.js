'use strict';

/**
 * GET /api/cron-bos-alerts — standalone trigger for the Inverted Flow BoS email alert.
 *
 * The alert normally fires automatically from api/cron-backtest-sync (it piggybacks the candle sync,
 * so no separate schedule or secret is needed). This endpoint remains for manual/dry runs and as an
 * option if you prefer a dedicated cron-job.org job.
 *
 * Auth: Vercel Cron header or CRON_SECRET bearer token.
 * Query: ?dry=1 compute only (no send, no log); ?asOf=<ms|ISO> replay a past cutoff.
 *
 * Research/notification only — no orders, no buy/sell signal, no profitability claim.
 */

const { getClient } = require('./_db');
const { runBosAlerts } = require('../src/bosAlerts');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function authorized(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  return !!(process.env.CRON_SECRET && auth === process.env.CRON_SECRET);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const q = req.query || {};
  const dry = q.dry === '1' || q.dry === 'true';
  const asOfMs = q.asOf ? (/^\d+$/.test('' + q.asOf) ? parseInt(q.asOf, 10) : Date.parse(q.asOf)) : undefined;

  try {
    const sb = getClient();
    const out = await runBosAlerts(sb, { asOfMs, dry });
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
