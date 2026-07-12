'use strict';

/**
 * GET /api/acceleration-v4-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Iterates every M15 timestamp in the range and records any *qualified*
 * Forex Acceleration v4 signal. Used by the History card on the page.
 *
 * Response:
 *   { rows: [ { time, pair, direction, finalScore, m15Accel, m15Velocity } ... ] }
 */

const v4 = require('./acceleration-v4.js');
const { cors } = require('./_db');
const { requirePlan } = require('./_plan');

const { createClient } = require('@supabase/supabase-js');

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Invoke the v4 handler internally with a mock res that captures the JSON.
async function invoke(query) {
  return await new Promise((resolve) => {
    const req = { method: 'GET', query, headers: {}, _internal: true };
    let payload = null;
    const res = {
      setHeader() {},
      status(c) { this._c = c; return this; },
      json(d) { payload = d; resolve({ status: this._c || 200, data: d }); return this; },
      end() { resolve({ status: this._c || 200, data: payload }); },
    };
    v4(req, res).catch((e) => resolve({ status: 500, data: { error: e.message } }));
  });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const gate = await requirePlan(getServiceClient(), req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const from = req.query?.from;
  const to   = req.query?.to;
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });

  const start = new Date(from + 'T00:00:00Z');
  const end   = new Date(to   + 'T23:45:00Z');
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'invalid dates' });

  // Iterate every 15 minutes across the range. Cap at 4000 anchors to keep the
  // serverless function bounded.
  const CAP = 4000;
  const rows = [];
  let anchor = new Date(start.getTime());
  let iterations = 0;
  const t0 = Date.now();

  while (anchor <= end && iterations < CAP) {
    // Skip weekends (Sat 00:00 UTC through Sun 21:00 UTC)
    const day = anchor.getUTCDay();
    const skipWeekend = day === 6 || (day === 0 && anchor.getUTCHours() < 21);
    if (!skipWeekend) {
      const date = anchor.toISOString().slice(0, 10);
      const time = String(anchor.getUTCHours()).padStart(2, '0') + ':' + String(anchor.getUTCMinutes()).padStart(2, '0');
      const r = await invoke({ date, time });
      if (r.status === 200 && r.data?.selected) {
        const s = r.data.selected;
        rows.push({
          time: r.data.generatedAt,
          pair: s.pair,
          direction: s.direction,
          finalScore: s.finalScore,
          m15Accel: s.components.m15Acceleration.score,
          m15Velocity: s.components.m15Velocity.score,
          candleControl: s.components.candleControl.score,
          compression: s.components.compression.score,
        });
      }
    }
    anchor = new Date(anchor.getTime() + 15 * 60000);
    iterations++;
  }

  res.json({
    from, to,
    anchors_scanned: iterations,
    qualified: rows.length,
    duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    rows,
  });
};

module.exports.maxDuration = 300;
