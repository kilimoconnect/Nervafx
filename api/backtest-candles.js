'use strict';

/**
 * GET /api/backtest-candles
 *
 * Returns historical candles from backtest_candles table.
 *
 * Query params:
 *   instrument  — required, e.g. EUR_USD
 *   timeframe   — required, H1 or M15
 *   from        — optional, ISO date string (default: 12 months ago)
 *   to          — optional, ISO date string (default: now)
 *   limit       — optional, max rows (default: 5000, max: 50000)
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const gate = await requirePlan(getClient(), req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  const { instrument, timeframe, from, to, limit } = req.query || {};

  if (!instrument) return res.status(400).json({ error: 'instrument required' });
  if (!timeframe || !['H1', 'M15'].includes(timeframe)) {
    return res.status(400).json({ error: 'timeframe must be H1 or M15' });
  }

  const maxRows = Math.min(50000, parseInt(limit || '5000', 10) || 5000);

  // Default range: 12 months ago → now
  const defaultFrom = new Date();
  defaultFrom.setUTCMonth(defaultFrom.getUTCMonth() - 12);
  const fromDate = from || defaultFrom.toISOString();
  const toDate   = to   || new Date().toISOString();

  try {
    const sb = getClient();
    const { data, error } = await sb
      .from('backtest_candles')
      .select('instrument,timeframe,time,open,high,low,close,volume')
      .eq('instrument', instrument)
      .eq('timeframe', timeframe)
      .gte('time', fromDate)
      .lte('time', toDate)
      .order('time', { ascending: true })
      .limit(maxRows);

    if (error) throw new Error(error.message);

    res.json({
      instrument,
      timeframe,
      count: (data || []).length,
      candles: data || [],
    });
  } catch (e) {
    console.error('[BACKTEST-CANDLES]', e.message);
    res.status(500).json({ error: e.message });
  }
};
