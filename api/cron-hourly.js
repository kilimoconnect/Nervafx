'use strict';

/**
 * GET /api/cron-hourly
 *
 * Called by Vercel Cron every hour at :05.
 * Skips silently when market is closed (Sat all day, Sun before 21:00 UTC, Fri from 21:00 UTC).
 * Protected by CRON_SECRET — Vercel injects this automatically when crons are configured.
 */

const { hourlyUpdate } = require('../src/updater');

function isMarketOpen() {
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 21) return false;
  if (day === 5 && hour >= 21) return false;
  return true;
}

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isMarketOpen()) {
    console.log('[CRON] Market closed — skipping.');
    return res.json({ ok: true, skipped: true, reason: 'market closed' });
  }

  try {
    const result = await hourlyUpdate();
    res.json({ ok: true, status: result.status });
  } catch (e) {
    console.error('[CRON-HOURLY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
