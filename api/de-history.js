'use strict';

/**
 * GET /api/de-history?days=14
 *
 * Returns Directional Efficiency (DE) per pair per hour for the archive.
 * DE = (net_move / total_travel) × 100 using last 20 candles at each time.
 * Combined: 0.40 × M15_DE + 0.60 × H1_DE
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

    // Fetch H1 candles (ascending)
    const PAGE = 1000;
    const h1All = [];
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('backtest_candles')
        .select('instrument, time, open, high, low, close')
        .eq('timeframe', 'H1')
        .eq('complete', true)
        .gte('time', since)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      h1All.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Fetch M15 candles (ascending)
    const m15All = [];
    offset = 0;
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

    // Group by instrument, compute DE at each H1 boundary using trailing 20 candles
    const h1ByPair = {}, m15ByPair = {};
    for (const c of h1All) {
      if (!h1ByPair[c.instrument]) h1ByPair[c.instrument] = [];
      h1ByPair[c.instrument].push({ open: +c.open, high: +c.high, low: +c.low, close: +c.close, time: c.time });
    }
    for (const c of m15All) {
      if (!m15ByPair[c.instrument]) m15ByPair[c.instrument] = [];
      m15ByPair[c.instrument].push({ open: +c.open, high: +c.high, low: +c.low, close: +c.close, time: c.time });
    }

    // For each pair, compute DE at each H1 candle time using trailing 20 candles
    const results = {};  // { time_key → { instrument → de_combined } }
    for (const [inst, h1Candles] of Object.entries(h1ByPair)) {
      const m15Candles = m15ByPair[inst] || [];
      for (let i = 19; i < h1Candles.length; i++) {
        const h1Window = h1Candles.slice(i - 19, i + 1);
        const t = new Date(h1Candles[i].time).toISOString().slice(0, 16);
        const h1DE = computeDE(h1Window);

        // Find M15 candles up to this H1 time (last 20)
        const cutoff = h1Candles[i].time;
        const m15Before = m15Candles.filter(c => c.time <= cutoff);
        const m15Window = m15Before.slice(-20);
        const m15DE = computeDE(m15Window);

        const combined = Math.round((0.40 * m15DE + 0.60 * h1DE) * 10) / 10;
        if (!results[t]) results[t] = {};
        results[t][inst] = combined;
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
