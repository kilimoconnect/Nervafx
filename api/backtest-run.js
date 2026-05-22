'use strict';

/**
 * POST /api/backtest-run
 *
 * Runs a full backtest over a date range.
 * Body: { from: "2025-06-01", to: "2026-05-01", maxBars: 48 }
 *
 * Returns full backtest results including trades, equity curve, stats.
 * Vercel function timeout: 300s (Pro plan).
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const gate = await requirePlan(getClient(), req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const { from, to, engine } = req.body || {};

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to dates required (YYYY-MM-DD)' });
  }

  try {
    // Dynamic import to avoid loading heavy modules on cold start for other endpoints
    const { runBacktest, interpretAnalysis } = require('../src/backtestEngine');

    const result = await runBacktest({
      from: new Date(from).toISOString(),
      to:   new Date(to).toISOString(),
      engine: engine || null,
    });

    // Generate AI interpretations for every section
    const insights = interpretAnalysis(result.analysis);

    res.json({ id: null, ...result, insights });
  } catch (e) {
    console.error('[BACKTEST-RUN]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 300;
