'use strict';

/**
 * GET /api/liquidity-failure-backtest
 *
 * Backtest report over stored outcomes (Portion 8B/E/F). Reports the four
 * setup-direction variants separately plus slices by classification, pair,
 * session, month, score band, level type, rotation agreement and Market Energy,
 * with stability flags. This is a Results view — deliberately separate from the
 * replay snapshot, which never shows outcomes.
 *
 * Query: from, to (ISO), pair, minScore, mode (for the confirmation comparison).
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { backtestReport, compareConfirmation } = require('./_lfe-metrics');
const { CONFIG } = require('./_lfe-constants');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    if (!req._internal) {
      const gate = await requirePlan(sb, req, 'premium');
      if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    }

    const q = req.query || {};
    let query = sb.from('liquidity_failure_outcomes')
      .select('signal_key, r_multiple, resolved_at, config_version, metrics')
      .eq('config_version', CONFIG.version)
      .limit(5000);
    if (q.from) query = query.gte('resolved_at', new Date(q.from).toISOString());
    if (q.to) query = query.lte('resolved_at', new Date(q.to).toISOString());

    const { data, error } = await query;
    if (error) throw error;

    // Flatten the stored metrics jsonb into outcome records for aggregation.
    let outs = (data || []).map((r) => Object.assign({}, r.metrics, { resultR: r.r_multiple }));
    if (q.pair) outs = outs.filter((o) => o.pair === q.pair);
    if (q.minScore) outs = outs.filter((o) => (o.score || 0) >= parseFloat(q.minScore));

    const report = backtestReport(outs, CONFIG);
    // Confirmation-value comparison is populated when records carry a `mode`.
    const withMode = outs.filter((o) => o.mode);

    res.json({
      engineVersion: CONFIG.version,
      sampleSize: outs.length,
      report,
      confirmationComparison: withMode.length ? compareConfirmation(withMode) : null,
      note: 'Outcomes are analytical only; profitability is not claimed unless an untouched test period stays positive after costs.',
    });
  } catch (e) {
    console.error('[liquidity-failure-backtest]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
