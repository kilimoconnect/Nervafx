'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const INSTRUMENTS = [
  'EUR_USD', 'GBP_USD', 'AUD_USD', 'NZD_USD',
  'USD_JPY', 'USD_CHF', 'USD_CAD',
  'EUR_GBP', 'EUR_JPY', 'EUR_CHF', 'EUR_CAD', 'EUR_AUD', 'EUR_NZD',
  'GBP_JPY', 'GBP_CHF', 'GBP_CAD', 'GBP_AUD', 'GBP_NZD',
  'AUD_JPY', 'AUD_CHF', 'AUD_CAD', 'AUD_NZD',
  'NZD_JPY', 'NZD_CHF', 'NZD_CAD',
  'CAD_JPY', 'CAD_CHF',
  'CHF_JPY',
];

const LOOKBACK = 10;

function scoreBreak(breakCandle, priorCandles, direction) {
  const body = Math.abs(breakCandle.close - breakCandle.open);
  const range = breakCandle.high - breakCandle.low;
  if (range === 0) return 0;

  // Body ratio: bigger body = cleaner break (less wick)
  const bodyRatio = body / range;

  // Wick against direction: penalise wicks on the wrong side
  let wickAgainst;
  if (direction === 'BUY') {
    wickAgainst = (breakCandle.high - breakCandle.close) / range;
  } else {
    wickAgainst = (breakCandle.open > breakCandle.close ? breakCandle.close : breakCandle.open - breakCandle.low) / range;
    wickAgainst = (breakCandle.close - breakCandle.low) / range;
  }

  // Break distance: how far past the level
  const level = direction === 'BUY'
    ? Math.max(...priorCandles.map(c => c.high))
    : Math.min(...priorCandles.map(c => c.low));
  const breakPrice = direction === 'BUY' ? breakCandle.close : breakCandle.close;
  const breakDist = direction === 'BUY'
    ? (breakPrice - level) / level
    : (level - breakPrice) / level;
  const distScore = Math.min(1, breakDist * 1000);

  // Impulse: is the candle moving in the break direction?
  const bullish = breakCandle.close > breakCandle.open;
  const impulse = (direction === 'BUY' && bullish) || (direction === 'SELL' && !bullish) ? 1 : 0.3;

  return Math.round((bodyRatio * 40 + (1 - wickAgainst) * 30 + distScore * 20 + impulse * 10));
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(30, parseInt(req.query?.days || '2', 10) || 2);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const fetchSince = new Date(new Date(since).getTime() - (LOOKBACK + 1) * 3600000).toISOString();

    const candlesByInst = {};
    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async (inst) => {
        const allData = [];
        const PAGE = 1000;
        let offset = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst)
            .eq('timeframe', 'H1')
            .eq('complete', true)
            .gte('time', fetchSince)
            .lte('time', until)
            .order('time', { ascending: true })
            .range(offset, offset + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          allData.push(...data);
          if (data.length < PAGE) break;
          offset += PAGE;
        }
        return { inst, data: allData };
      }));
      for (const { inst, data } of results) {
        candlesByInst[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    // Build breaks per hourly timestamp
    const allTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const c of (candlesByInst[inst] || [])) {
        if (c.time >= since && c.time <= until) allTimes.add(c.time);
      }
    }
    const timestamps = [...allTimes].sort();

    // Index candles by time per instrument
    const indexByInst = {};
    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst] || [];
      const timeToIdx = {};
      for (let i = 0; i < candles.length; i++) timeToIdx[candles[i].time] = i;
      indexByInst[inst] = { candles, timeToIdx };
    }

    const rows = [];
    for (const time of timestamps) {
      const breaks = [];

      for (const inst of INSTRUMENTS) {
        const { candles, timeToIdx } = indexByInst[inst];
        const idx = timeToIdx[time];
        if (idx === undefined || idx < LOOKBACK) continue;

        const current = candles[idx];
        const prior = candles.slice(idx - LOOKBACK, idx);
        if (prior.length < LOOKBACK) continue;

        const highestHigh = Math.max(...prior.map(c => c.high));
        const lowestLow = Math.min(...prior.map(c => c.low));

        let direction = null;
        if (current.close > highestHigh) direction = 'BUY';
        else if (current.close < lowestLow) direction = 'SELL';

        if (!direction) continue;

        const score = scoreBreak(current, prior, direction);
        const level = direction === 'BUY' ? highestHigh : lowestLow;
        const breakDist = Math.abs(current.close - level);
        const body = Math.abs(current.close - current.open);
        const range = current.high - current.low;
        const wickPct = range > 0 ? Math.round((1 - body / range) * 100) : 100;

        breaks.push({
          pair: inst.replace('_', '/'),
          direction,
          score,
          level,
          close: current.close,
          breakPips: breakDist,
          wickPct,
          body,
          range,
        });
      }

      if (!breaks.length) continue;
      breaks.sort((a, b) => b.score - a.score);

      rows.push({
        time,
        breaks: breaks.slice(0, 5),
        totalBreaks: breaks.length,
      });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
