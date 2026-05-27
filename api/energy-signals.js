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

    // Get peak single hourly bar energy (not session average).
    // Direction is set by whichever hourly bar first crossed 50 — it persists
    // until a new bar crosses 50 again. The number shown = peak bar today.
    const todayStr = new Date().toISOString().slice(0, 10);
    let { data: sessions } = await sb
      .from('market_energy_sessions')
      .select('session_name, market_energy, details')
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
          .select('session_name, market_energy, details')
          .eq('session_date', latest[0].session_date);
        sessions = fb || [];
      }
    }

    // Scan every hourly bar across all sessions to find the peak single bar
    let peakBarEnergy = 0;
    let peakBarTime = null;
    let peakBarSession = null;
    for (const s of (sessions || [])) {
      const hourly = s.details?.hourly || [];
      for (const h of hourly) {
        const hEnergy = parseFloat(h.market_energy) || 0;
        if (hEnergy > peakBarEnergy) {
          peakBarEnergy = hEnergy;
          peakBarTime = h.time || null;
          peakBarSession = s.session_name;
        }
      }
      // Also consider session-level as a bar (in case hourly is empty)
      const sessEnergy = parseFloat(s.market_energy) || 0;
      if (sessEnergy > peakBarEnergy) {
        peakBarEnergy = sessEnergy;
        peakBarSession = s.session_name;
      }
    }

    res.json({
      currencies: currencies || [],
      pairs: pairs || [],
      energy: peakBarEnergy,
      peakBarTime,
      peakBarSession,
      thresholdMet: peakBarEnergy >= 50,
    });
  } catch (e) {
    console.error('[ENERGY-SIGNALS-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
