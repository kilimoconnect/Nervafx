'use strict';

/**
 * GET /api/currency-movement-15m-engine
 *
 * NervaFX Currency Movement Engine — 15M twin. Same eight-currency decomposition
 * as /currency-movement-engine, but the primary/structural timeframe is M15
 * (BOS over the previous 20 M15 candles) with M5 as the micro layer. Analytical.
 *
 *   Live       (no ?at): evaluates as of now; persistence ENABLED.
 *   Historical (?at=ISO): reconstructs a past M15 close, read-only (no persistence).
 *   ?enhance15m=0 disables the M5 micro refinement layer.
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { scanAll } = require('./_cme15-scan');
const { persistCme15 } = require('./_cme15-persist');
const { isHistoricalRequest, localStr } = require('./_h1c-time');
const { ENGINE_KEY, ENGINE_VERSION, M15_MS } = require('./_cme15-constants');

const DEFAULT_TZ = 'Africa/Dar_es_Salaam';
const snapToM15 = (ms) => Math.floor(ms / M15_MS) * M15_MS;

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
    const enhanceMicro = q.enhance15m !== '0';

    let evalMs, requestedAtMs = null;
    if (historical) {
      requestedAtMs = new Date(q.at).getTime();
      if (isNaN(requestedAtMs)) return res.status(400).json({ error: 'invalid ?at timestamp' });
      evalMs = snapToM15(requestedAtMs);
    } else {
      evalMs = Date.now();
    }

    const scan = await scanAll(sb, { evalMs, enhanceMicro });

    if (historical) {
      scan.persistence = { ok: false, skipped: true, reason: 'historical read-only — persistence disabled' };
      scan.historicalMode = true;
      scan.requestedAtUtc = new Date(requestedAtMs).toISOString();
      scan.evaluatedAtUtc = new Date(evalMs).toISOString();
      scan.evaluatedAtLocal = localStr(evalMs, tz);
      scan.timezone = tz;
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    } else {
      const p = await persistCme15(sb, scan);
      scan.persistence = { ok: p.persisted, rows: p.rows, error: p.error || null };
      scan.historicalMode = false;
    }
    scan.engineKey = ENGINE_KEY;
    scan.engineVersion = ENGINE_VERSION;
    res.json(scan);
  } catch (e) {
    console.error('[currency-movement-15m-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
