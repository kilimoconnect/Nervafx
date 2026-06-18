'use strict';

/**
 * GET /api/energy-signals
 *
 * Returns current energy-driven currency directions and active signal pairs.
 * Supports 2-slot direction confirmation system with session expiry.
 */

const { cors, getClient } = require('./_db');
const { requirePlan }     = require('./_plan');

const SESSION_ORDER = { ASIA: 0, LONDON: 1, NEW_YORK: 2 };

function getSession(utcHour) {
  if (utcHour >= 23 || utcHour < 7)  return 'ASIA';
  if (utcHour >= 7  && utcHour < 13) return 'LONDON';
  if (utcHour >= 13 && utcHour < 21) return 'NEW_YORK';
  return 'LOW_LIQUIDITY';
}

function getSessionDate(now, session) {
  const d = new Date(now);
  if (session === 'ASIA' && d.getUTCHours() === 23) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function sessionNum(dateStr, session) {
  if (!dateStr || !session) return 0;
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = Math.floor(d.getTime() / 86400000);
  return days * 3 + (SESSION_ORDER[session] || 0);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'free');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const { data: currencies, error: cErr } = await sb
      .from('energy_currency_state')
      .select('*')
      .order('slot', { ascending: true });
    if (cErr) throw cErr;

    const { data: pairs, error: pErr } = await sb
      .from('energy_signal_pairs')
      .select('*')
      .eq('active', true)
      .order('trigger_energy', { ascending: false });
    if (pErr) throw pErr;

    // Momentum check (mirrors energyDirection.js)
    const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

    const { data: csRows } = await sb
      .from('currency_strength')
      .select('currency, smooth_6h, time')
      .order('time', { ascending: false })
      .limit(24);

    const byTime = {};
    for (const r of (csRows || [])) {
      const tk = r.time;
      if (!byTime[tk]) byTime[tk] = {};
      if (!byTime[tk][r.currency]) {
        byTime[tk][r.currency] = parseFloat(r.smooth_6h) || 0;
      }
    }
    const timeKeys = Object.keys(byTime).sort();
    const last3 = timeKeys.slice(-3);

    const sums = last3.map(tk => {
      const vals = CURRENCIES.filter(c => byTime[tk]?.[c] !== undefined).map(c => byTime[tk][c]);
      if (vals.length < 2) return 0;
      return Math.abs(Math.max(...vals)) + Math.abs(Math.min(...vals));
    });

    const hasMomentum = sums.length === 3 && sums[2] > sums[1] && sums[1] > sums[0] && sums[2] >= 0.003;
    const csSumPips = Math.round((sums[sums.length - 1] || 0) * 10000);

    const activeCurrencies = (currencies || []).filter(c => c.active);
    const hasActiveDirections = activeCurrencies.length > 0;
    const hasActivePairs = (pairs || []).some(p => p.active);
    const thresholdMet = hasMomentum || hasActiveDirections || hasActivePairs;

    // Compute session info for expiry display
    const now = new Date();
    const currSession = getSession(now.getUTCHours());
    const currDate = getSessionDate(now, currSession);
    const currSessNum = sessionNum(currDate, currSession);

    // Build slot summaries
    const slots = {};
    for (const c of activeCurrencies) {
      const sn = c.slot || 1;
      if (!slots[sn]) {
        const confNum = sessionNum(c.confirmed_date, c.confirmed_session);
        const elapsed = currSessNum - confNum;
        slots[sn] = {
          slot: sn,
          confirmed_session: c.confirmed_session,
          confirmed_date: c.confirmed_date,
          sessions_remaining: Math.max(0, 2 - elapsed),
          trigger_energy: c.energy_at_trigger,
          currencies: [],
        };
      }
      slots[sn].currencies.push(c);
    }

    let displayEnergy;
    if (hasMomentum) {
      displayEnergy = csSumPips;
    } else if (hasActiveDirections) {
      const storedTrigger = activeCurrencies.find(c => c.energy_at_trigger);
      displayEnergy = storedTrigger?.energy_at_trigger || 0;
    } else {
      displayEnergy = csSumPips;
    }

    res.json({
      currencies: currencies || [],
      pairs: pairs || [],
      slots: Object.values(slots),
      energy: displayEnergy,
      triggerEnergy: csSumPips,
      currentSession: currSession,
      threshold_met: thresholdMet,
    });
  } catch (e) {
    console.error('[ENERGY-SIGNALS-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
