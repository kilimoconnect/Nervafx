'use strict';

/**
 * GET /api/h1-continuation-history?date=YYYY-MM-DD&timezone=<IANA>
 *
 * Full-day historical timeline for the H1 Continuation Engine. Replays every
 * completed H1 boundary of the selected local day through the SAME evaluateSetup()
 * as live mode and returns hourly summaries + state transitions. Read-only —
 * never persists. Premium-gated, following project route conventions.
 */

const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const { replayDay } = require('./_h1c-history');

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
    const date = q.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required as YYYY-MM-DD' });
    }
    const timezone = q.timezone || DEFAULT_TZ;

    const body = await replayDay(sb, { date, timezone });
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400'); // immutable past day
    res.json(body);
  } catch (e) {
    console.error('[h1-continuation-history]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
