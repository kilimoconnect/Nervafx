'use strict';

/**
 * GET /api/currency-movement-h1-engine
 *
 * NervaFX Currency Movement Engine — H1 variant. Same eight-currency
 * decomposition, primary/structural timeframe H1 (BOS over the previous 5 H1
 * candles) refined by M15 micro-structure. Analytical only.
 *
 *   Live       (no ?at): evaluates as of now; persistence ENABLED (cme_* tables).
 *   Historical (?at=ISO): reconstructs a past H1 close, read-only (no persistence).
 *   ?enhance15m=0 disables the M15 micro refinement layer.
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { scanAll } = require('./_cme-scan');
const { persistCme } = require('./_cme-persist');
const { snapToH1, isHistoricalRequest, localStr } = require('./_h1c-time');
const { ENGINE_KEY, ENGINE_VERSION } = require('./_cme-constants');

const DEFAULT_TZ = 'Africa/Dar_es_Salaam';

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
    const historical = isHistoricalRequest(q);
    const tz = q.timezone || DEFAULT_TZ;
    const enhance15m = q.enhance15m !== '0';

    let evalMs, requestedAtMs = null;
    if (historical) {
      requestedAtMs = new Date(q.at).getTime();
      if (isNaN(requestedAtMs)) return res.status(400).json({ error: 'invalid ?at timestamp' });
      evalMs = snapToH1(requestedAtMs);
    } else {
      evalMs = Date.now();
    }

    const scan = await scanAll(sb, { evalMs, enhance15m });

    if (historical) {
      scan.persistence = { ok: false, skipped: true, reason: 'historical read-only — persistence disabled' };
      scan.historicalMode = true;
      scan.requestedAtUtc = new Date(requestedAtMs).toISOString();
      scan.evaluatedAtUtc = new Date(evalMs).toISOString();
      scan.evaluatedAtLocal = localStr(evalMs, tz);
      scan.timezone = tz;
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    } else {
      const p = await persistCme(sb, scan);
      scan.persistence = { ok: p.persisted, rows: p.rows, error: p.error || null };
      scan.historicalMode = false;
    }
    scan.engineKey = ENGINE_KEY;
    scan.engineVersion = ENGINE_VERSION;
    res.json(scan);
  } catch (e) {
    console.error('[currency-movement-h1-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
