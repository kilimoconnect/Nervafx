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

    // Momentum trigger: 2H CS sum increasing for 3 consecutive hours (mirrors src/energyDirection.js)
    const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

    const { data: csRows } = await sb
      .from('currency_strength')
      .select('currency, smooth_2h, time')
      .order('time', { ascending: false })
      .limit(24); // 8 currencies × 3 hours

    const byTime = {};
    for (const r of (csRows || [])) {
      const tk = r.time;
      if (!byTime[tk]) byTime[tk] = {};
      if (!byTime[tk][r.currency]) {
        byTime[tk][r.currency] = parseFloat(r.smooth_2h) || 0;
      }
    }
    const timeKeys = Object.keys(byTime).sort();
    const last3 = timeKeys.slice(-3);

    const sums = last3.map(tk => {
      const vals = CURRENCIES.filter(c => byTime[tk]?.[c] !== undefined).map(c => byTime[tk][c]);
      if (vals.length < 2) return 0;
      return Math.abs(Math.max(...vals)) + Math.abs(Math.min(...vals));
    });

    const hasMomentum = sums.length === 3 && sums[2] > sums[1] && sums[1] > sums[0] && sums[2] >= 0.0015;
    const csSumPips = Math.round((sums[sums.length - 1] || 0) * 10000);

    const hasActiveDirections = (currencies || []).some(c => c.active && c.direction !== 'NEUTRAL');
    const hasActivePairs = (pairs || []).some(p => p.active);
    const thresholdMet = hasMomentum || hasActiveDirections || hasActivePairs;

    let displayEnergy;
    if (hasMomentum) {
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
      threshold_met: thresholdMet,
    });
  } catch (e) {
    console.error('[ENERGY-SIGNALS-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
