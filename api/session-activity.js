'use strict';

const { getClient, cors } = require('./_db');

// Returns hourly rows + session summaries for the dashboard activity graphs.
// Query params:
//   ?days=7        — how many calendar days to return (default 7, max 30)
//   ?type=hourly   — hourly rows only
//   ?type=summary  — session summaries only
//   ?type=both     — both (default)

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const days    = Math.min(730, parseInt(req.query?.days || '7', 10) || 7);
    const type    = req.query?.type || 'both';
    const sb      = getClient();
    const since   = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const result = {};

    if (type === 'hourly' || type === 'both') {
      // Paginate — Supabase caps at 1000 rows per request
      const allRows = [];
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await sb
          .from('hourly_session_activity')
          .select('time_utc, session_name, movement_score, breadth_score, agreement_score, volatility_score, market_energy, expansion_readiness, compression_score, expansion_score, pairs_moving, pairs_quiet, market_state, tradability_score, directional_control, volatility_quality, volatility_type, momentum_score, momentum_type, chaos_score, currency_leadership_gap, false_breakout_risk, energy_cycle')
          .gte('time_utc', since)
          .order('time_utc', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (!data || !data.length) break;
        allRows.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      result.hourly = allRows;
    }

    if (type === 'summary' || type === 'both') {
      const sinceDateStr = since.slice(0, 10);
      const { data, error } = await sb
        .from('session_performance_summary')
        .select('session_date_utc, session_name, avg_movement_score, max_movement_score, avg_breadth_score, max_breadth_score, avg_directional_agreement, expansion_score, session_energy_score, session_state, dominant_state, pairs_moving_avg, expansion_hours, compression_hours')
        .gte('session_date_utc', sinceDateStr)
        .order('session_date_utc', { ascending: true });
      if (error) throw error;
      result.summaries = data || [];
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
