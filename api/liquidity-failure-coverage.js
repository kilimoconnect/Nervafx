'use strict';

/**
 * GET /api/liquidity-failure-coverage
 *
 * Data-coverage descriptor for the Liquidity Failure Engine replay UI. Coverage
 * is derived live from stored candles (never hardcoded) and reused across the
 * request. commonEarliest is set by the latest-starting pair/timeframe;
 * commonLatest by the earliest-ending one.
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { getCoverageCached } = require('./_lfe-scan');
const { CONFIG, DISPLAY_TIMEZONES } = require('./_lfe-constants');

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

    const cov = await getCoverageCached(sb, req.query?.refresh === '1');
    if (!cov.ok) return res.status(503).json({ error: 'NO_COVERAGE', warnings: cov.warnings || [] });

    res.json({
      engineVersion: CONFIG.version,
      configurationVersion: CONFIG.version,
      commonEarliest: cov.commonEarliestRawIso,
      earliestSelectable: cov.earliestSelectableIso,
      commonLatest: cov.commonLatestIso,
      warmupMs: cov.warmupMs,
      coverageByPair: cov.perPair
        ? Object.fromEntries(Object.entries(cov.perPair).map(([p, v]) => [p, {
          earliest: new Date(v.pairEarliest).toISOString(),
          latestClose: new Date(v.pairLatestClose).toISOString(),
        }]))
        : {},
      missingCandleWarnings: cov.warnings,
      displayTimezones: DISPLAY_TIMEZONES,
    });
  } catch (e) {
    console.error('[liquidity-failure-coverage]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
