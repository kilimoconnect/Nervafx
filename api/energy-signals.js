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

    // Find the LAST (most recent) hourly bar that crossed 50.
    // That's the bar that set or confirmed the current direction.
    // Collect all hourly bars, sort by time, find the latest one >= 50.
    const allBars = [];
    for (const s of (sessions || [])) {
      const hourly = s.details?.hourly || [];
      for (const h of hourly) {
        allBars.push({
          energy: parseFloat(h.market_energy) || 0,
          time: h.time || null,
          session: s.session_name,
        });
      }
    }
    // Sort by time descending (most recent first)
    allBars.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

    // Trigger bar = most recent hourly bar that crossed ≥55 (H1 threshold)
    const ENERGY_THRESHOLD_H1 = 55;
    const triggerBar = allBars.find(b => b.energy >= ENERGY_THRESHOLD_H1);
    const triggerEnergy = triggerBar?.energy || 0;

    // ── Flow spread check: 6+ pairs with 3H spread ≥ 20 pips ──
    const FLOW_SPREAD_THRESHOLD = 20;
    const FLOW_SPREAD_MIN_PAIRS = 1;
    const VALID_PAIRS = [
      'AUD_CAD','AUD_CHF','AUD_JPY','AUD_NZD','AUD_USD',
      'CAD_CHF','CAD_JPY','CHF_JPY',
      'EUR_AUD','EUR_CAD','EUR_CHF','EUR_GBP','EUR_JPY','EUR_NZD','EUR_USD',
      'GBP_AUD','GBP_CAD','GBP_CHF','GBP_JPY','GBP_NZD','GBP_USD',
      'NZD_CAD','NZD_CHF','NZD_JPY','NZD_USD',
      'USD_CAD','USD_CHF','USD_JPY',
    ];

    // Build currency 3H strength map from currency_strength (same source as Flow Performance)
    const { data: csRows } = await sb
      .from('currency_strength')
      .select('currency, smooth_3h')
      .order('time', { ascending: false })
      .limit(8);
    const ccyStrength = {};
    for (const r of (csRows || [])) {
      if (!ccyStrength[r.currency]) ccyStrength[r.currency] = parseFloat(r.smooth_3h) || 0;
    }

    let flowSpreadCount = 0;
    for (const inst of VALID_PAIRS) {
      const [base, quote] = inst.split('_');
      const bVal = ccyStrength[base] || 0;
      const qVal = ccyStrength[quote] || 0;
      const spreadPips = Math.abs(bVal - qVal) * 10000;
      if (spreadPips >= FLOW_SPREAD_THRESHOLD) flowSpreadCount++;
    }
    const flowSpreadMet = flowSpreadCount >= FLOW_SPREAD_MIN_PAIRS;

    // Directions persist across days — check if active directions exist in the DB.
    const hasActiveDirections = (currencies || []).some(c => c.active && c.direction !== 'NEUTRAL');
    const hasActivePairs = (pairs || []).some(p => p.active);
    const energyMet = triggerEnergy >= ENERGY_THRESHOLD_H1;
    const thresholdMet = (energyMet && flowSpreadMet) || hasActiveDirections || hasActivePairs;

    // Display energy: use the stored trigger energy from DB when no today trigger bar
    // This preserves the energy level that originally confirmed directions
    let displayEnergy;
    if (triggerEnergy >= ENERGY_THRESHOLD_H1) {
      // Today has a trigger bar — show it
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
      flowSpreadCount,
      flowSpreadMet,
    });
  } catch (e) {
    console.error('[ENERGY-SIGNALS-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
