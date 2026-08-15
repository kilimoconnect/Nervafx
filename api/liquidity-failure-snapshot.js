'use strict';

/**
 * GET /api/liquidity-failure-snapshot?at=<ISO_UTC>&timezone=<IANA_ZONE>
 * GET /api/liquidity-failure-snapshot?mode=latest_available
 *
 * Point-in-time replay of the whole Liquidity Failure Engine. Strict as-of:
 * only candles closed by the normalized evaluation time are used; pivots,
 * delayed follow-ups, M15 confirmations and invalidations after that time are
 * invisible; outcomes are never returned. Non-quarter-hour selections snap down
 * to the previous completed M15 close.
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { getCoverageCached, resolveSnapshotTime, scanSnapshot } = require('./_lfe-scan');
const { EVAL_MODE } = require('./_lfe-constants');

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

    const cov = await getCoverageCached(sb);
    if (!cov.ok) return res.status(503).json({ error: 'NO_COVERAGE', warnings: cov.warnings || [] });

    const input = {
      at: req.query?.at || null,
      timezone: req.query?.timezone || 'UTC',
      mode: req.query?.mode === EVAL_MODE.LATEST_AVAILABLE ? EVAL_MODE.LATEST_AVAILABLE : undefined,
    };
    const resolved = resolveSnapshotTime(input, cov);
    if (!resolved.ok) return res.status(422).json(resolved.error);

    const body = await scanSnapshot(sb, resolved.ctx, cov);

    // Immutable historical snapshots are cacheable for a long time; the
    // latest-available view changes as new candles arrive.
    if (resolved.ctx.mode === EVAL_MODE.HISTORICAL) {
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    } else {
      res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');
    }
    res.json(body);
  } catch (e) {
    console.error('[liquidity-failure-snapshot]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
