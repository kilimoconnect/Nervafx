'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

// Returns historical currency strength rows for charting.
// Query params:
//   ?days=30   — how many calendar days (default 30, max 730)
//   ?tf=3h     — timeframe: 3h, 6h, 12h (default 3h)

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const gate = await requirePlan(getClient(), req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    const days  = Math.min(730, parseInt(req.query?.days || '30', 10) || 30);
    const tf    = req.query?.tf || '3h';
    const multi = req.query?.multi === '1'; // return both 3h + 6h for flow perf
    const field = tf === '12h' ? 'smooth_12h' : tf === '6h' ? 'smooth_6h' : 'smooth_3h';
    const selectFields = multi
      ? 'time, currency, smooth_3h, smooth_6h, smooth_12h'
      : `time, currency, ${field}`;
    const sb    = getClient();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Paginate — Supabase caps at 1000 rows per request
    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select(selectFields)
        .gte('time', since)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    res.json({ rows: allRows, field });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
