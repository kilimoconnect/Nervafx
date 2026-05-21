'use strict';

/**
 * GET /api/market-energy-history
 *
 * Returns the last 14 days of session rows from market_energy_sessions,
 * ordered most-recent first. Used by the history panel on the dashboard.
 */

const { cors, getClient } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const cutoff = new Date();
    const days = Math.min(730, parseInt(req.query?.days || '5', 10) || 5);
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

    // Paginate — Supabase caps at 1000 rows per request
    const allData = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('market_energy_sessions')
        .select('*')
        .gte('session_date', cutoffStr)
        .neq('session_name', 'LOW_LIQUIDITY')
        .order('session_date', { ascending: false })
        .order('session_name',  { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      allData.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Merge computed fields from details JSON back to top-level
    const rows = allData.map(r => {
      if (r.details && typeof r.details === 'object') {
        const { hours, hourly, ...computed } = r.details;
        return { ...r, ...computed, details: { hours, hourly } };
      }
      return r;
    });
    res.json(rows);
  } catch (e) {
    console.error('[ME-HISTORY]', e.message);
    res.status(500).json({ error: e.message });
  }
};
