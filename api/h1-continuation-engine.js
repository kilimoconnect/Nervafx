'use strict';

/**
 * GET /api/h1-continuation-engine
 *
 * NervaFX H1 Continuation Engine — scans all 28 pairs on direct completed H1
 * candles and returns per-pair continuation state + a ranked setup list.
 * Analytical only (no entries). ?at=ISO replays historically; ?debug=1 attaches
 * per-pair traces (off by default).
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { scanAll } = require('./_h1c-scan');
const { persistScan } = require('./_h1c-persist');

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

    const debug = req.query?.debug === '1';
    let evalMs = Date.now();
    if (req.query?.at) { const t = new Date(req.query.at).getTime(); if (!isNaN(t)) evalMs = Math.min(t, Date.now()); }

    const scan = await scanAll(sb, { evalMs, debug });

    // Best-effort persistence — the scan result is returned regardless.
    const persistence = await persistScan(sb, scan);
    scan.persistence = { ok: persistence.persisted, transitionsAppended: persistence.transitionsAppended, error: persistence.error || null };

    res.json(scan);
  } catch (e) {
    console.error('[h1-continuation-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
