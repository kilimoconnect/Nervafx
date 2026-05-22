'use strict';

/**
 * GET /api/market-energy
 *
 * Delegates entirely to sessionActivity.getMarketEnergyData() which computes
 * everything from 200 in-memory candles — norm_*, prev_*, energy_momentum,
 * expansionPressure, marketCycle — without a second DB read.
 */

const { cors, getClient }     = require('./_db');
const { getMarketEnergyData } = require('../src/sessionActivity');
const { requirePlan }         = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const gate = await requirePlan(getClient(), req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    const data = await getMarketEnergyData();
    if (!data) return res.json({ sessions: [], expansionPressure: null, marketCycle: null });
    res.json(data);
  } catch (e) {
    console.error('[MARKET-ENERGY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
