'use strict';

/**
 * POST /api/liquidity-failure-backfill
 *
 * Chronological historical backfill of the Liquidity Failure Engine over stored
 * H1/M15 data. Append-only and idempotent — never erases history. Admin-gated by
 * the LFE_ADMIN_KEY header. Bounded per invocation (maxSteps) with a resumable
 * checkpoint, so long runs are driven by repeated calls.
 *
 * Query: from, to (ISO), maxSteps, batchPairs, dryRun=1, checkpoint (ms).
 */

const { cors, getClient } = require('./_db');
const { getCoverageCached, evaluatePair } = require('./_lfe-scan');
const { fetchPairData } = require('./_lfe-data');
const { runBackfill, createMemoryStore } = require('./_lfe-backfill');
const { createDbStore } = require('./_lfe-persist');
const { CONFIG } = require('./_lfe-constants');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = process.env.LFE_ADMIN_KEY;
  if (!req._internal && (!admin || req.headers['x-lfe-admin'] !== admin)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const sb = getClient();
  try {
    const cov = await getCoverageCached(sb);
    if (!cov.ok) return res.status(503).json({ error: 'NO_COVERAGE' });

    const q = req.query || {};
    const from = q.from ? new Date(q.from).getTime() : cov.earliestSelectable;
    const to = q.to ? new Date(q.to).getTime() : cov.latestAvailable;
    const dryRun = q.dryRun === '1';
    const maxSteps = q.maxSteps ? parseInt(q.maxSteps, 10) : 96; // ~1 day of M15 per call by default
    const checkpoint = q.checkpoint ? { nextMs: parseInt(q.checkpoint, 10) } : null;

    const store = dryRun ? createMemoryStore() : createDbStore(sb, CONFIG);

    // Real evaluator: fetch as-of candles, evaluate one pair at one moment.
    const evaluate = async (pair, evalMs) => {
      const data = await fetchPairData(sb, pair, evalMs);
      return evaluatePair(pair, data, evalMs, { rotation: null }, CONFIG);
    };

    const result = await runBackfill({
      evaluate, store, from, to, dryRun, maxSteps, checkpoint,
      batchPairs: q.batchPairs ? parseInt(q.batchPairs, 10) : CONFIG.backtest.batchPairs,
      cfg: CONFIG,
    });

    res.json(result);
  } catch (e) {
    console.error('[liquidity-failure-backfill]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 300;
