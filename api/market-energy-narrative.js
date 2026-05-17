'use strict';

/**
 * GET /api/market-energy-narrative
 *
 * Returns the latest AI decision intelligence result stored by the hourly cron.
 * If no result is stored yet, generates one on-demand and saves it for next time.
 */

const { cors, getClient }        = require('./_db');
const { generateMarketNarrative } = require('../src/narrativeEngine');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const { data } = await sb
      .from('market_energy_narrative')
      .select('result, computed_at')
      .eq('id', 1)
      .single();

    if (data?.result) return res.json(data.result);

    // Nothing stored yet — generate live and persist for subsequent requests
    const result = await generateMarketNarrative();
    res.json(result);
  } catch (e) {
    console.error('[ME-NARRATIVE]', e.message);
    res.status(500).json({ error: e.message });
  }
};
