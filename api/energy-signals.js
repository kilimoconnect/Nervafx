'use strict';

/**
 * GET /api/energy-signals
 *
 * Returns current energy-driven currency directions and active signal pairs.
 * No plan gate — available to all users.
 *
 * Response: {
 *   currencies: [...],   // energy_currency_state rows
 *   pairs: [...],        // energy_signal_pairs rows (active only)
 *   energy: number,      // current market energy level
 *   thresholdMet: bool
 * }
 */

const { cors, getClient } = require('./_db');
const { requirePlan }     = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'free');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    // Fetch currency state
    const { data: currencies, error: cErr } = await sb
      .from('energy_currency_state')
      .select('*')
      .order('currency', { ascending: true });
    if (cErr) throw cErr;

    // Fetch active signal pairs
    const { data: pairs, error: pErr } = await sb
      .from('energy_signal_pairs')
      .select('*')
      .eq('active', true)
      .order('trigger_energy', { ascending: false });
    if (pErr) throw pErr;

    // Get current energy from latest session
    const todayStr = new Date().toISOString().slice(0, 10);
    let { data: sessions } = await sb
      .from('market_energy_sessions')
      .select('session_name, market_energy')
      .eq('session_date', todayStr)
      .order('session_name', { ascending: true });

    if (!sessions?.length) {
      const { data: latest } = await sb
        .from('market_energy_sessions')
        .select('session_date')
        .order('session_date', { ascending: false })
        .limit(1);
      if (latest?.[0]) {
        const { data: fb } = await sb
          .from('market_energy_sessions')
          .select('session_name, market_energy')
          .eq('session_date', latest[0].session_date);
        sessions = fb || [];
      }
    }

    const maxEnergy = Math.max(0, ...(sessions || []).map(s => parseFloat(s.market_energy) || 0));

    res.json({
      currencies: currencies || [],
      pairs: pairs || [],
      energy: maxEnergy,
      thresholdMet: maxEnergy >= 50,
    });
  } catch (e) {
    console.error('[ENERGY-SIGNALS-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
