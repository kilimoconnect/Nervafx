'use strict';

/**
 * GET /api/de-history?days=14
 *
 * Returns Directional Efficiency (DE) per pair per hour for the archive.
 * DE = (net_move / total_travel) × 100 using last 20 M15 candles only.
 *
 * Optimised: fetches one instrument at a time (avoids loading 50K+ rows)
 * and uses index-based lookups instead of repeated .filter() scans.
 */

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const INSTRUMENTS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

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

    // Process instruments in parallel batches of 7 to keep DB load reasonable
    const BATCH = 7;
    const rows = [];

    for (let i = 0; i < INSTRUMENTS.length; i += BATCH) {
      const batch = INSTRUMENTS.slice(i, i + BATCH);
      await Promise.all(batch.map(async (inst) => {
        // Fetch candles for this single instrument — typically ~1700 rows for 30 days
        const PAGE = 1000;
        const candles = [];
        let offset = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('timeframe', 'M15')
            .eq('complete', true)
            .eq('instrument', inst)
            .gte('time', since)
            .order('time', { ascending: true })
            .range(offset, offset + PAGE - 1);
          if (error) throw error;
          if (!data?.length) break;
          candles.push(...data);
          if (data.length < PAGE) break;
          offset += PAGE;
        }
        if (candles.length < 2) return;

        // Collect unique hour boundaries for this instrument
        const hourSet = new Set();
        for (const c of candles) {
          const t = new Date(c.time);
          t.setUTCMinutes(0, 0, 0);
          hourSet.add(t.toISOString().slice(0, 16));
        }

        // Walk through candles once using a sliding window approach
        // Candles are sorted ascending — for each hour, find the cutoff index
        const parsed = candles.map(c => ({
          open: +c.open, high: +c.high, low: +c.low, close: +c.close, time: c.time
        }));
        const hours = [...hourSet].sort();

        let searchStart = 0; // optimise: start search from last found position
        for (const hourKey of hours) {
          const cutoffDate = new Date(hourKey + ':00Z');
          cutoffDate.setUTCHours(cutoffDate.getUTCHours() + 1);
          const cutoff = cutoffDate.toISOString();

          // Find index of first candle >= cutoff (binary-ish, but sequential is fine since hours are sorted)
          let cutIdx = searchStart;
          while (cutIdx < parsed.length && parsed[cutIdx].time < cutoff) cutIdx++;

          if (cutIdx < 2) continue;
          const windowStart = Math.max(0, cutIdx - 20);
          const window = parsed.slice(windowStart, cutIdx);
          if (window.length < 2) continue;

          const de = Math.round(computeDE(window) * 10) / 10;
          rows.push({ time: hourKey, instrument: inst, de_combined: de });

          // Next hour search can start from current position
          searchStart = Math.max(0, cutIdx - 20);
        }
      }));
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
