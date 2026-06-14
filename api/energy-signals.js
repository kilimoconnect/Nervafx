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

    // Trigger: 6H currency strength sum ≥ 40 pips (mirrors src/energyDirection.js)
    const CS_SUM_THRESHOLD = 0.004;
    const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

    const { data: csRows } = await sb
      .from('currency_strength')
      .select('currency, smooth_6h')
      .order('time', { ascending: false })
      .limit(8);

    const ccyMap = {};
    const seen = new Set();
    for (const r of (csRows || [])) {
      if (seen.has(r.currency)) continue;
      seen.add(r.currency);
      ccyMap[r.currency] = parseFloat(r.smooth_6h) || 0;
    }

    const h6Values = CURRENCIES.filter(c => ccyMap[c] !== undefined).map(c => ccyMap[c]);
    let csSumPips = 0;
    if (h6Values.length >= 2) {
      const strongest = Math.max(...h6Values);
      const weakest = Math.min(...h6Values);
      csSumPips = Math.round((Math.abs(strongest) + Math.abs(weakest)) * 10000);
    }
    const csTrigger = csSumPips >= Math.round(CS_SUM_THRESHOLD * 10000);

    const hasActiveDirections = (currencies || []).some(c => c.active && c.direction !== 'NEUTRAL');
    const hasActivePairs = (pairs || []).some(p => p.active);
    const thresholdMet = csTrigger || hasActiveDirections || hasActivePairs;

    let displayEnergy;
    if (csTrigger) {
      displayEnergy = csSumPips;
    } else if (hasActiveDirections) {
      const storedTrigger = (currencies || []).find(c => c.energy_at_trigger);
      displayEnergy = storedTrigger?.energy_at_trigger || 0;
    } else {
      displayEnergy = csSumPips;
    }

    res.json({
      currencies: currencies || [],
      pairs: pairs || [],
      energy: displayEnergy,
      triggerEnergy: csSumPips,
      peakBarTime: null,
      peakBarSession: null,
      thresholdMet,
    });
  } catch (e) {
    console.error('[ENERGY-SIGNALS-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
