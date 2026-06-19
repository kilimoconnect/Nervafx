'use strict';

/**
 * GET /api/compression-breakout
 *
 * Returns compression baseline state and M15 structure watch for all pairs.
 * Pro+ plan required.
 */

const { cors, getClient } = require('./_db');
const { requirePlan }     = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const [baselineRes, watchRes] = await Promise.all([
      sb.from('compression_baseline').select('*').eq('id', 1).single(),
      sb.from('m15_structure_watch').select('*').not('state', 'in', '("INACTIVE","REMOVED","APPROVED","VALIDATING")').order('state'),
    ]);

    const baseline   = baselineRes.data || null;
    const structures = (watchRes.data || []).sort((a, b) => {
      const order = { ENTRY: 0, WAITING: 1 };
      return (order[a.state] ?? 9) - (order[b.state] ?? 9);
    });

    res.json({
      baseline,
      structures,
      summary: {
        entry:   structures.filter(s => s.state === 'ENTRY').length,
        waiting: structures.filter(s => s.state === 'WAITING').length,
      },
    });
  } catch (e) {
    console.error('[COMP-BRK-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
