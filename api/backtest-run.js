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

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { from, to, maxBars } = req.body || {};

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to dates required (YYYY-MM-DD)' });
  }

  try {
    // Dynamic import to avoid loading heavy modules on cold start for other endpoints
    const { runBacktest, saveBacktestResult, interpretAnalysis } = require('../src/backtestEngine');

    const result = await runBacktest({
      from: new Date(from).toISOString(),
      to:   new Date(to).toISOString(),
      maxBars: maxBars || 48,
    });

    // Generate AI interpretations for every section
    const insights = interpretAnalysis(result.analysis);

    // Save to DB (non-blocking — don't fail if save fails)
    const id = await saveBacktestResult(result).catch(e => {
      console.warn('[BACKTEST-API] Save failed:', e.message);
      return null;
    });

    res.json({ id, ...result, insights });
  } catch (e) {
    console.error('[BACKTEST-RUN]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 300;
