'use strict';

/**
 * GET /api/volume-analysis
 *
 * Returns M15 volume analysis data (participation intelligence).
 *
 * Query params:
 *   ?days=7       — lookback days (default 7, max 730)
 *   ?instrument=EUR_USD  — filter to specific pair (optional)
 *   ?session=LONDON      — filter to specific session (optional)
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

    const days       = Math.min(730, parseInt(req.query?.days || '7', 10) || 7);
    const instrument = req.query?.instrument || null;
    const session    = req.query?.session || null;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const allRows = [];
    const PAGE = 1000;
    let offset = 0;

    while (true) {
      let query = sb
        .from('m15_volume_analysis')
        .select('time, instrument, session, volume, relative_volume, volume_acceleration, volume_persistence, volume_efficiency, participation_score, participation_grade')
        .gte('time', since)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);

      if (instrument) query = query.eq('instrument', instrument);
      if (session)    query = query.eq('session', session);

      const { data, error } = await query;
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    res.json({ rows: allRows });
  } catch (e) {
    console.error('[VOLUME-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
