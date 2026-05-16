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

const SESSION_ORDER    = ['ASIA', 'LONDON', 'NEW_YORK', 'LOW_LIQUIDITY'];
const SESS_LABEL       = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
const COMPRESSED_CYCLE = new Set(['DEAD', 'COMPRESSION', 'PRESSURE_BUILDING']);

function computeExpansionPressure(sequence) {
  // sequence is recent active sessions in chronological order
  // Find the trailing run of compressed sessions (working backwards)
  const trailing = [];
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (COMPRESSED_CYCLE.has(sequence[i].energy_cycle)) {
      trailing.unshift(sequence[i]);
    } else {
      break;
    }
  }

  const streak = trailing.length;
  const risk   = streak >= 3 ? 'HIGH' : streak >= 2 ? 'BUILDING' : streak >= 1 ? 'LOW' : 'NONE';
  const chain  = trailing.map(s => SESS_LABEL[s.session_name] || s.session_name);

  return { streak, risk, chain, cycles: trailing.map(s => s.energy_cycle) };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb    = getClient();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cols  =
      'session_date, session_name, session_start, session_end, ' +
      'movement_score, breadth_score, agreement_score, volatility_score, ' +
      'acceleration_score, compression_score, compression_streak, ' +
      'expansion_readiness, market_energy, energy_cycle, active_pairs, ' +
      'bullish_breadth, bearish_breadth, ' +
      'dominance_score, strongest_ccy, weakest_ccy';

    // Fetch last 7 days, all rows, newest first
    const { data, error } = await sb
      .from('market_energy_sessions')
      .select(cols)
      .gte('session_date', since)
      .order('session_date',  { ascending: false })
      .order('session_start', { ascending: false });

    if (error) throw error;

    const rows = data || [];

    // Most recent row per session_name for the 4 cards
    const bySession = {};
    for (const row of rows) {
      if (!bySession[row.session_name]) bySession[row.session_name] = row;
    }
    const sessions = SESSION_ORDER.map(n => bySession[n] || null).filter(Boolean);

    // Recent active sessions in chronological order (skip LOW_LIQUIDITY) for pressure panel
    const sequence = rows
      .filter(r => r.session_name !== 'LOW_LIQUIDITY')
      .reverse()   // oldest → newest
      .slice(-8);  // last 8 active sessions

    const expansionPressure = computeExpansionPressure(sequence);

    res.json({ sessions, expansionPressure });
  } catch (e) {
    console.error('[MARKET-ENERGY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
