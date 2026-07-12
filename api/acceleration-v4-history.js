'use strict';

/**
 * GET /api/acceleration-v4-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Pre-fetches H1 + M15 candles for every pair across the range ONCE, then
 * iterates every 15-minute anchor in memory. Much faster than invoking the
 * live handler per anchor — a 1-day scan is ~56 DB queries instead of ~5400.
 */

const { createClient } = require('@supabase/supabase-js');
const { cors, getClient } = require('./_db');
const { requirePlan } = require('./_plan');
const v4 = require('./acceleration-v4.js');

const VALID_PAIRS = v4.VALID_PAIRS;
const analysePair = v4.analysePair;

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Fetch all candles for one pair/timeframe across a wide window with pagination.
async function fetchAll(sb, inst, tf, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close, volume')
      .eq('instrument', inst).eq('timeframe', tf)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({
      time: c.time,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low:  parseFloat(c.low),
      close: parseFloat(c.close),
      volume: c.volume == null ? 0 : Number(c.volume),
      _ms: new Date(c.time).getTime(),
    })));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
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

  const t0 = Date.now();
  const sb = getClient();

  // Fetch enough history for the indicators to warm up. H1 needs 51 candles for
  // EMA50; M15 needs 51 for ATR50. Add generous buffer for the earliest anchor.
  const fetchSince = new Date(start.getTime() - 5 * 24 * 3600000).toISOString();
  const fetchUntil = new Date(end.getTime()   + 60 * 60000).toISOString();

  const cache = {};
  const errors = [];
  for (let b = 0; b < VALID_PAIRS.length; b += 7) {
    const batch = VALID_PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try {
        const [h1, m15] = await Promise.all([
          fetchAll(sb, inst, 'H1',  fetchSince, fetchUntil),
          fetchAll(sb, inst, 'M15', fetchSince, fetchUntil),
        ]);
        cache[inst] = { h1, m15 };
      } catch (e) {
        errors.push(`${inst}: ${e.message}`);
        cache[inst] = { h1: [], m15: [] };
      }
    }));
  }

  const rows = [];
  const CAP = 4000;
  let anchor = new Date(start.getTime());
  let iterations = 0;

  while (anchor <= end && iterations < CAP) {
    const day = anchor.getUTCDay();
    const skipWeekend = day === 6 || (day === 0 && anchor.getUTCHours() < 21);
    if (!skipWeekend) {
      const anchorMs = anchor.getTime();
      const results = [];
      for (const inst of VALID_PAIRS) {
        const cached = cache[inst];
        if (!cached) continue;
        // Slice to snapshots strictly on or before the anchor
        const h1Slice  = cached.h1.filter(c  => c._ms  <= anchorMs);
        const m15Slice = cached.m15.filter(c => c._ms <= anchorMs);
        if (h1Slice.length < 51 || m15Slice.length < 51) continue;
        const r = analysePair(inst, h1Slice, m15Slice);
        if (r) results.push(r);
      }
      results.sort((a, b) => b.finalScore - a.finalScore);
      const selected = results.find(r => r.qualifies);
      if (selected) {
        rows.push({
          time: anchor.toISOString(),
          pair: selected.pair,
          direction: selected.direction,
          finalScore: selected.finalScore,
          m15Accel: selected.components.m15Acceleration.score,
          m15Velocity: selected.components.m15Velocity.score,
          candleControl: selected.components.candleControl.score,
          compression: selected.components.compression.score,
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
    errors: errors.slice(0, 5),
    rows,
  });
};

module.exports.maxDuration = 300;
