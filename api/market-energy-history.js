'use strict';

/**
 * GET /api/market-energy-history
 *
 * Returns the last 3 days of session rows from market_energy_sessions,
 * ordered most-recent first. Used by the history panel on the dashboard.
 */

const { cors, getClient } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

    const { data, error } = await sb
      .from('market_energy_sessions')
      .select('*')
      .gte('session_date', cutoffStr)
      .neq('session_name', 'LOW_LIQUIDITY')
      .order('session_date', { ascending: false })
      .order('session_name',  { ascending: true });

    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (e) {
    console.error('[ME-HISTORY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
