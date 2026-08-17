'use strict';

/**
 * GET /api/h1-continuation-engine
 *
 * NervaFX H1 Continuation Engine — scans all 28 pairs on direct completed H1
 * candles and returns per-pair continuation state + a ranked setup list.
 * Analytical only (no entries).
 *
 *   Live      (no ?at): evaluates as of now; persistence ENABLED (unchanged).
 *   Historical (?at=ISO): reconstructs state as of a past H1 close using the SAME
 *                         scanAll()/evaluateSetup(); persistence DISABLED — a
 *                         read-only reconstruction that can never touch live state.
 *
 * ?timezone=<IANA> only affects the *_Local metadata strings (default EAT).
 * ?debug=1 attaches per-pair traces.
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { scanAll } = require('./_h1c-scan');
const { persistScan } = require('./_h1c-persist');
const { h1DataBounds } = require('./_h1c-data');
const { snapToH1, isHistoricalRequest, localStr } = require('./_h1c-time');
const { HOUR_MS, ENGINE_VERSION, CONFIGURATION_VERSION } = require('./_h1c-constants');

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
    const debug = q.debug === '1';
    const historical = isHistoricalRequest(q);
    const tz = q.timezone || DEFAULT_TZ;

    // Data availability (best-effort) — used for metadata and future/past bounds.
    let bounds = null;
    try { bounds = await h1DataBounds(sb); } catch (_) { bounds = null; }

    let evalMs;
    let requestedAtMs = null;
    if (historical) {
      requestedAtMs = new Date(q.at).getTime();
      if (isNaN(requestedAtMs)) return res.status(400).json({ error: 'invalid ?at timestamp' });
      evalMs = snapToH1(requestedAtMs);   // snap DOWN to the latest completed H1 close

      // Reject/clearly-handle out-of-range historical requests — never silently
      // fall back to live data.
      if (bounds && bounds.latestCloseMs != null && evalMs > bounds.latestCloseMs) {
        return res.json(unavailableEnvelope('NO_DATA', 'Requested time is in the future / beyond available data.', requestedAtMs, evalMs, tz, bounds));
      }
      if (bounds && bounds.earliestCloseMs != null && evalMs < bounds.earliestCloseMs) {
        return res.json(unavailableEnvelope('NO_DATA', 'Requested time is before the earliest available data.', requestedAtMs, evalMs, tz, bounds));
      }
    } else {
      evalMs = Date.now();
    }

    const scan = await scanAll(sb, { evalMs, debug });

    // ── read-only enforcement ────────────────────────────────────────────────
    if (historical) {
      scan.persistence = { ok: false, skipped: true, reason: 'historical read-only — persistence disabled' };
    } else {
      const persistence = await persistScan(sb, scan);
      scan.persistence = { ok: persistence.persisted, transitionsAppended: persistence.transitionsAppended, error: persistence.error || null };
    }

    // ── response metadata (added compatibly; live shape preserved) ───────────
    scan.engineVersion = ENGINE_VERSION;
    scan.configurationVersion = CONFIGURATION_VERSION;
    scan.dataAvailableFrom = bounds && bounds.earliestCloseMs != null ? new Date(bounds.earliestCloseMs).toISOString() : null;
    scan.dataAvailableTo = bounds && bounds.latestCloseMs != null ? new Date(bounds.latestCloseMs).toISOString() : null;

    if (historical) {
      scan.historicalMode = true;
      scan.requestedAtUtc = new Date(requestedAtMs).toISOString();
      scan.evaluatedAtUtc = new Date(evalMs).toISOString();
      scan.evaluatedAtLocal = localStr(evalMs, tz);
      scan.timezone = tz;
      scan.lastCompletedCandleUtc = new Date(evalMs).toISOString();      // the candle that closed at evalMs
      scan.lastCompletedCandleLocal = localStr(evalMs, tz);
      scan.dataStatus = scan.evaluated > 0 ? 'OK' : 'NO_SETUP_OR_DATA';
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400'); // immutable past
    } else {
      scan.historicalMode = false;
    }

    res.json(scan);
  } catch (e) {
    console.error('[h1-continuation-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

function unavailableEnvelope(dataStatus, message, requestedAtMs, evalMs, tz, bounds) {
  return {
    historicalMode: true,
    dataStatus,
    message,
    requestedAtUtc: new Date(requestedAtMs).toISOString(),
    evaluatedAtUtc: new Date(evalMs).toISOString(),
    evaluatedAtLocal: localStr(evalMs, tz),
    timezone: tz,
    engineVersion: ENGINE_VERSION,
    configurationVersion: CONFIGURATION_VERSION,
    dataAvailableFrom: bounds && bounds.earliestCloseMs != null ? new Date(bounds.earliestCloseMs).toISOString() : null,
    dataAvailableTo: bounds && bounds.latestCloseMs != null ? new Date(bounds.latestCloseMs).toISOString() : null,
    timeframe: 'H1',
    setups: [],
    pairs: [],
    persistence: { ok: false, skipped: true, reason: 'historical read-only — persistence disabled' },
  };
}

module.exports.maxDuration = 60;
