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

    // Fetch aggregated M15 volume participation scores (avg across 28 instruments per time slot)
    const volMap = {};
    try {
      let vOffset = 0;
      while (true) {
        const { data: vRows, error: vErr } = await sb
          .from('m15_volume_analysis')
          .select('time, participation_score')
          .gte('time', since)
          .order('time', { ascending: true })
          .range(vOffset, vOffset + PAGE - 1);
        if (vErr) { console.warn('[M15-ENERGY-API] volume fetch:', vErr.message); break; }
        if (!vRows || !vRows.length) break;
        for (const r of vRows) {
          const key = r.time;
          if (!volMap[key]) volMap[key] = { sum: 0, count: 0 };
          volMap[key].sum += parseFloat(r.participation_score) || 0;
          volMap[key].count++;
        }
        if (vRows.length < PAGE) break;
        vOffset += PAGE;
      }
    } catch (_) {}

    // Attach avg volume to each energy bar
    for (const bar of allRows) {
      const v = volMap[bar.time_utc];
      bar.volume_score = v && v.count > 0 ? Math.round(v.sum / v.count) : null;
    }

    res.json({ bars: allRows });
  } catch (e) {
    console.error('[M15-ENERGY-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
