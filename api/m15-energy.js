'use strict';

/**
 * GET /api/m15-energy
 *
 * Returns M15 energy bars for charting.
 * Query params:
 *   ?days=3  — how many calendar days to return (default 3, max 7)
 */

const { cors, getClient } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const days  = Math.min(7, parseInt(req.query?.days || '3', 10) || 3);
    const sb    = getClient();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('m15_energy_bars')
        .select('time_utc, session_name, market_energy, movement_score, breadth_score, agreement_score, dispersion_score, volatility_score')
        .gte('time_utc', since)
        .order('time_utc', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    res.json({ bars: allRows });
  } catch (e) {
    console.error('[M15-ENERGY-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
