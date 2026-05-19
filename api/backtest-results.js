'use strict';

/**
 * GET /api/backtest-results
 *
 * Returns saved backtest runs, most recent first.
 * Query: ?limit=20
 */

const { cors, getClient } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const limit = Math.min(50, parseInt(req.query?.limit || '20', 10) || 20);

  try {
    const sb = getClient();
    const { data, error } = await sb
      .from('backtest_results')
      .select('*')
      .order('run_date', { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (e) {
    console.error('[BACKTEST-RESULTS]', e.message);
    res.status(500).json({ error: e.message });
  }
};
