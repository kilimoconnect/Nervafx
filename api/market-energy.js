'use strict';

/**
 * GET /api/market-energy
 *
 * Returns the most recent completed row per session from market_energy_sessions
 * (ASIA, LONDON, NEW_YORK, LOW_LIQUIDITY), ordered for display.
 *
 * Response: { sessions: [ { session_name, energy_cycle, market_energy,
 *   expansion_readiness, movement_score, breadth_score, agreement_score,
 *   volatility_score, compression_streak, session_date, session_start } ] }
 */

const { getClient, cors } = require('./_db');

const SESSION_ORDER = ['ASIA', 'LONDON', 'NEW_YORK', 'LOW_LIQUIDITY'];

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb    = getClient();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { data, error } = await sb
      .from('market_energy_sessions')
      .select(
        'session_date, session_name, session_start, session_end, ' +
        'movement_score, breadth_score, agreement_score, volatility_score, ' +
        'acceleration_score, compression_score, compression_streak, ' +
        'expansion_readiness, market_energy, energy_cycle, active_pairs'
      )
      .gte('session_date', since)
      .order('session_date',  { ascending: false })
      .order('session_start', { ascending: false });

    if (error) throw error;

    // Keep the most recent row per session_name
    const bySession = {};
    for (const row of data || []) {
      if (!bySession[row.session_name]) bySession[row.session_name] = row;
    }

    const sessions = SESSION_ORDER
      .map(name => bySession[name] || null)
      .filter(Boolean);

    res.json({ sessions });
  } catch (e) {
    console.error('[MARKET-ENERGY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
