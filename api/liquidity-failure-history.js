'use strict';

/**
 * GET /api/liquidity-failure-history
 *
 * Persisted signals/events within a date range, filterable and paginated. Reads
 * only the replay tables — eventual-outcome data (liquidity_failure_outcomes) is
 * never mixed in.
 *
 * Query: from, to, direction, failedSide, setupType, pair, state, minimumScore,
 *        limit (≤200), offset.
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
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
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

    let query = sb.from('liquidity_failure_signals')
      .select('signal_key, pair, direction, setup_type, classification, score, state, first_seen_at, updated_at, config_version, payload', { count: 'exact' })
      .order('first_seen_at', { ascending: false });

    if (q.from) query = query.gte('first_seen_at', new Date(q.from).toISOString());
    if (q.to) query = query.lte('first_seen_at', new Date(q.to).toISOString());
    if (q.direction) query = query.eq('direction', q.direction);
    if (q.setupType) query = query.eq('setup_type', q.setupType);
    if (q.pair) query = query.eq('pair', q.pair);
    if (q.state) query = query.eq('state', q.state);
    if (q.minimumScore) query = query.gte('score', parseFloat(q.minimumScore));

    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // failedSide lives in the payload; filter in JS to keep the schema additive.
    let items = data || [];
    if (q.failedSide) items = items.filter((r) => r.payload && r.payload.failedSide === q.failedSide);

    res.json({
      engineVersion: CONFIG.version,
      page: { limit, offset, count: count != null ? count : items.length, returned: items.length },
      items,
    });
  } catch (e) {
    console.error('[liquidity-failure-history]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
