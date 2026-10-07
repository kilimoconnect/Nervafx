'use strict';

/**
 * GET /api/m15-workspace — real-data payload for the manual-decision workspace.
 *
 * Loads completed M15 candles for the 28 pairs from backtest_candles (mid, OANDA),
 * and builds the workspace payload (per-pair candles + a recent frame sequence,
 * each immutable as-of its close) via the shared research builder. Read-only:
 * never writes, never places/suggests an order. Research classification only — the
 * model is UNVALIDATED (no demonstrated edge); no profitability is reported.
 *
 *   ?frames=N   recent closes per pair (default 40, max 96)
 */

const { getClient, cors } = require('./_db');
const { loadAllPairsFromDb, PAIRS } = require('../research/m15/loader');
const { buildWorkspacePayload } = require('../research/m15/workspaceFrame');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const frames = Math.max(8, Math.min(96, parseInt((req.query && req.query.frames) || '40', 10) || 40));
    const sb = getClient();
    // ~5 days covers 48h context + swing calibration + ATR warm-up + the replay window.
    const fromIso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const histories = await loadAllPairsFromDb(sb, { pairs: PAIRS, fromIso });
    const payload = buildWorkspacePayload(histories, { pairs: PAIRS, frames, provenance: 'LIVE' });
    res.json({ ok: true, ...payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
