'use strict';

/**
 * GET /api/subscription
 *
 * Returns the authenticated user's current subscription plan.
 * If no subscription row exists, returns { plan: 'free' }.
 */

const { cors, getClient } = require('./_db');
const { verifyToken, getPlan } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const { user, error: authErr } = await verifyToken(sb, req);
    if (!user) return res.status(401).json({ error: authErr || 'Unauthorized' });

    const sub = await getPlan(sb, user.id);
    res.json(sub);
  } catch (e) {
    console.error('[SUBSCRIPTION]', e.message);
    res.status(500).json({ error: e.message });
  }
};
