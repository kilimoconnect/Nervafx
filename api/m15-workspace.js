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
    const frames = Math.max(1, Math.min(96, parseInt((req.query && req.query.frames) || '12', 10) || 12));
    // Optional ?asOf=<ms|ISO> → build the workspace AS OF a historical close (causal: no
    // candles after asOf are loaded). Future/invalid values fall back to live.
    const asOfRaw = req.query && req.query.asOf;
    let nowMs = Date.now(), mode = 'live';
    if (asOfRaw != null && asOfRaw !== '') { const t = /^\d+$/.test('' + asOfRaw) ? parseInt(asOfRaw, 10) : Date.parse(asOfRaw); if (!isNaN(t) && t < Date.now()) { nowMs = t; mode = 'historical'; } }

    const sb = getClient();
    // ~6 days covers 48h context + swing calibration + ATR warm-up + the replay window.
    const fromIso = new Date(nowMs - 6 * 24 * 60 * 60 * 1000).toISOString();
    const loadOpts = { pairs: PAIRS, fromIso };
    if (mode === 'historical') loadOpts.toIso = new Date(nowMs).toISOString();
    const histories = await loadAllPairsFromDb(sb, loadOpts);
    const payload = buildWorkspacePayload(histories, { pairs: PAIRS, frames, provenance: 'LIVE', now: nowMs });
    payload.meta.mode = mode; payload.meta.asOf = new Date(nowMs).toISOString();
    res.json({ ok: true, ...payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
