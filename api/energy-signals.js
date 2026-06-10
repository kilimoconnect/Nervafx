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

    // Trigger bar = most recent FULL-CONFLUENCE hourly bar: energy ≥ threshold
    // AND all five supporting engines green (same structure as pink bars).
    // Mirrors src/energyDirection.js.
    const ENERGY_THRESHOLD_H1 = 60;
    const CONFLUENCE_THRESHOLDS = {
      dispersion_score:  30,
      tradability_score: 30,
      movement_score:    35,
      breadth_score:     80,
      agreement_score:   35,
    };
    const isConfluenceBar = (r) => {
      if ((parseFloat(r.market_energy) || 0) < ENERGY_THRESHOLD_H1) return false;
      for (const [field, min] of Object.entries(CONFLUENCE_THRESHOLDS)) {
        if ((parseFloat(r[field]) || 0) < min) return false;
      }
      return true;
    };

    const since = new Date(Date.now() - 72 * 3600000).toISOString();
    const { data: hourlyRows } = await sb
      .from('hourly_session_activity')
      .select('time_utc, session_name, market_energy, dispersion_score, tradability_score, movement_score, breadth_score, agreement_score')
      .gte('time_utc', since)
      .order('time_utc', { ascending: false });

    const triggerRow = (hourlyRows || []).find(isConfluenceBar) || null;
    const triggerBar = triggerRow ? {
      energy: parseFloat(triggerRow.market_energy) || 0,
      time: triggerRow.time_utc,
      session: triggerRow.session_name,
    } : null;
    const triggerEnergy = triggerBar?.energy || 0;
    const allBars = (hourlyRows || []).map(r => ({
      energy: parseFloat(r.market_energy) || 0,
      time: r.time_utc,
      session: r.session_name,
    }));

    // Directions persist across days — check if active directions exist in the DB.
    const hasActiveDirections = (currencies || []).some(c => c.active && c.direction !== 'NEUTRAL');
    const hasActivePairs = (pairs || []).some(p => p.active);
    const thresholdMet = !!triggerBar || hasActiveDirections || hasActivePairs;

    // Display energy: use the stored trigger energy from DB when no today trigger bar
    // This preserves the energy level that originally confirmed directions
    let displayEnergy;
    if (triggerBar) {
      // Recent confluence trigger bar — show it
      displayEnergy = triggerEnergy;
    } else if (hasActiveDirections) {
      // Directions active from previous trigger — show stored energy_at_trigger
      const storedTrigger = (currencies || []).find(c => c.energy_at_trigger);
      displayEnergy = storedTrigger?.energy_at_trigger || (allBars[0]?.energy || 0);
    } else {
      // No active directions — show current energy
      displayEnergy = allBars[0]?.energy || 0;
    }

    res.json({
      currencies: currencies || [],
      pairs: pairs || [],
      energy: displayEnergy,
      triggerEnergy,
      peakBarTime: triggerBar?.time || null,
      peakBarSession: triggerBar?.session || null,
      thresholdMet,
    });
  } catch (e) {
    console.error('[ENERGY-SIGNALS-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
