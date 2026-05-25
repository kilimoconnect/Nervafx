'use strict';

/**
 * GET /api/de-history?days=14
 *
 * Returns Directional Efficiency (DE) per pair per hour for the archive.
 * DE = (net_move / total_travel) × 100 using last 20 M15 candles only.
 */

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

function computeDE(candles) {
  if (!candles || candles.length < 2) return 0;
  const netMove = Math.abs(candles[candles.length - 1].close - candles[0].open);
  let totalTravel = 0;
  for (const c of candles) totalTravel += c.high - c.low;
  if (totalTravel === 0) return 0;
  return Math.min(100, (netMove / totalTravel) * 100);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const gate = await requirePlan(getClient(), req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(30, parseInt(req.query?.days || '14', 10) || 14);
    const sb = getClient();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Fetch M15 candles (ascending)
    const PAGE = 1000;
    const m15All = [];
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('backtest_candles')
        .select('instrument, time, open, high, low, close')
        .eq('timeframe', 'M15')
        .eq('complete', true)
        .gte('time', since)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      m15All.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Group M15 candles by instrument (ascending by time)
    const m15ByPair = {};
    for (const c of m15All) {
      if (!m15ByPair[c.instrument]) m15ByPair[c.instrument] = [];
      m15ByPair[c.instrument].push({ open: +c.open, high: +c.high, low: +c.low, close: +c.close, time: c.time });
    }

    // Collect unique hour boundaries from M15 candle times
    const hourSet = new Set();
    for (const c of m15All) {
      const t = new Date(c.time);
      t.setUTCMinutes(0, 0, 0);
      hourSet.add(t.toISOString().slice(0, 16));
    }
    const hours = [...hourSet].sort();

    // For each pair, compute DE at each hour boundary using trailing 20 M15 candles
    const results = {};  // { time_key → { instrument → de_combined } }
    for (const [inst, m15Candles] of Object.entries(m15ByPair)) {
      for (const hourKey of hours) {
        // Find M15 candles up to this hour's end (hour + 59 min)
        const cutoffDate = new Date(hourKey + ':00Z');
        cutoffDate.setUTCHours(cutoffDate.getUTCHours() + 1);
        const cutoff = cutoffDate.toISOString();

        const m15Before = m15Candles.filter(c => c.time < cutoff);
        if (m15Before.length < 2) continue;
        const m15Window = m15Before.slice(-20);
        const de = Math.round(computeDE(m15Window) * 10) / 10;

        if (!results[hourKey]) results[hourKey] = {};
        results[hourKey][inst] = de;
      }
    }

    // Flatten to array for transport
    const rows = [];
    for (const [time, pairs] of Object.entries(results)) {
      for (const [instrument, de] of Object.entries(pairs)) {
        rows.push({ time, instrument, de_combined: de });
      }
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
