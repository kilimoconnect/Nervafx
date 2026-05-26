'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const gate = await requirePlan(getClient(), req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    const days = Math.min(730, parseInt(req.query?.days || '30', 10) || 30);
    const sb = getClient();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    // Try with de_combined first; fall back to without if column doesn't exist yet
    let selectCols = 'time, instrument, smooth_45m, smooth_90m, state, de_combined';
    while (true) {
      const { data, error } = await sb
        .from('m15_pair_spreads')
        .select(selectCols)
        .gte('time', since)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error && offset === 0 && error.message?.includes('de_combined')) {
        // Column doesn't exist yet — retry without it
        selectCols = 'time, instrument, smooth_45m, smooth_90m, state';
        continue;
      }
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    res.json({ rows: allRows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
