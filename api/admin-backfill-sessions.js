'use strict';

/**
 * POST /api/admin-backfill-sessions
 *
 * Triggers backfillSessionActivity() which processes 200 in-memory candles
 * and upserts all session rows to market_energy_sessions.
 * Admin-only (requires valid JWT for the admin user ID).
 */

const { cors } = require('./_db');
const { backfillSessionActivity } = require('../src/sessionActivity');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';

function getSubFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.sub;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (getSubFromToken(token) !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });

  try {
    const result = await backfillSessionActivity();
    res.json({ ok: true, rows: result?.rows });
  } catch (e) {
    console.error('[BACKFILL-SESSIONS]', e.message);
    res.status(500).json({ error: e.message });
  }
};
