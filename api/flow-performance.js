'use strict';

/**
 * GET /api/flow-performance
 *
 * Returns pre-computed flow performance data.
 *
 * Query params:
 *   ?days=7       — lookback days (default 7, max 730)
 *   ?session=LONDON  — filter to specific session (optional)
 *
 * Returns: { rows: [...] } sorted by time ascending
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'free');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days    = Math.min(730, parseInt(req.query?.days || '7', 10) || 7);
    const session = req.query?.session || null;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const allRows = [];
    const PAGE = 1000;
    let offset = 0;

    while (true) {
      let query = sb
        .from('flow_performance')
        .select('time, instrument, session, dir, rank, status, state, momentum, perf_score, final_score, de_combined, spread_3h, spread_6h, v45, v90, vol_rv, vol_eff, vol_grade, vol_pers, impulse_score, impulse_aligned, strong_currencies, weak_currencies')
        .gte('time', since)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);

      if (session) query = query.eq('session', session);

      const { data, error } = await query;
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    res.json({ rows: allRows });
  } catch (e) {
    console.error('[FLOW-PERF-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
