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
      sb.from('m15_structure_watch').select('*').neq('state', 'INACTIVE').order('state'),
    ]);

    const baseline   = baselineRes.data || null;
    const structures = (watchRes.data || []).sort((a, b) => {
      const order = { ENTRY_READY: 0, STRUCTURE_FORMED: 1, PULLBACK_ACTIVE: 2, IMPULSE_DETECTED: 3, WATCHING: 4 };
      return (order[a.state] ?? 9) - (order[b.state] ?? 9);
    });

    res.json({
      baseline,
      structures,
      summary: {
        entry_ready:      structures.filter(s => s.state === 'ENTRY_READY').length,
        structure_formed: structures.filter(s => s.state === 'STRUCTURE_FORMED').length,
        pullback_active:  structures.filter(s => s.state === 'PULLBACK_ACTIVE').length,
        impulse_detected: structures.filter(s => s.state === 'IMPULSE_DETECTED').length,
        watching:         structures.filter(s => s.state === 'WATCHING').length,
      },
    });
  } catch (e) {
    console.error('[COMP-BRK-API]', e.message);
    res.status(500).json({ error: e.message });
  }
};
