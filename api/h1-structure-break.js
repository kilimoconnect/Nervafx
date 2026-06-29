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

const NY_CLOSE_UTC = 21;

function forexDayKey(iso) {
  const d = new Date(iso);
  if (d.getUTCHours() >= NY_CLOSE_UTC) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function prevTradingDay(dayKey) {
  const d = new Date(dayKey + 'T12:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 1) d.setUTCDate(d.getUTCDate() - 3);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function scoreBreak(breakCandle, direction, level) {
  const body = Math.abs(breakCandle.close - breakCandle.open);
  const range = breakCandle.high - breakCandle.low;
  if (range === 0) return 0;

  const bodyRatio = body / range;

  let wickAgainst;
  if (direction === 'BUY') {
    wickAgainst = (breakCandle.high - breakCandle.close) / range;
  } else {
    wickAgainst = (breakCandle.close - breakCandle.low) / range;
  }

  const breakDist = direction === 'BUY'
    ? (breakCandle.close - level) / level
    : (level - breakCandle.close) / level;
  const distScore = Math.min(1, breakDist * 1000);

  const bullish = breakCandle.close > breakCandle.open;
  const impulse = (direction === 'BUY' && bullish) || (direction === 'SELL' && !bullish) ? 1 : 0.3;

  return Math.round(bodyRatio * 40 + (1 - wickAgainst) * 30 + distScore * 20 + impulse * 10);
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
    // Fetch extra 3 days back to cover previous trading day (weekend gap)
    const fetchSince = new Date(new Date(since).getTime() - 4 * 24 * 3600000).toISOString();

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

    // Build daily high/low per instrument per forex day
    const dailyHL = {};
    for (const inst of INSTRUMENTS) {
      const byDay = {};
      for (const c of (candlesByInst[inst] || [])) {
        const day = forexDayKey(c.time);
        if (!byDay[day]) byDay[day] = { high: c.high, low: c.low };
        else {
          if (c.high > byDay[day].high) byDay[day].high = c.high;
          if (c.low < byDay[day].low) byDay[day].low = c.low;
        }
      }
      dailyHL[inst] = byDay;
    }

    // Collect timestamps in range
    const allTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const c of (candlesByInst[inst] || [])) {
        if (c.time >= since && c.time <= until) allTimes.add(c.time);
      }
    }
    const timestamps = [...allTimes].sort();

    // Index candles
    const indexByInst = {};
    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst] || [];
      const timeToIdx = {};
      for (let i = 0; i < candles.length; i++) timeToIdx[candles[i].time] = i;
      indexByInst[inst] = { candles, timeToIdx };
    }

    const rows = [];
    for (const time of timestamps) {
      const fxDay = forexDayKey(time);
      const prevDay = prevTradingDay(fxDay);
      const breaks = [];

      for (const inst of INSTRUMENTS) {
        const hl = (dailyHL[inst] || {})[prevDay];
        if (!hl) continue;

        const { candles, timeToIdx } = indexByInst[inst];
        const idx = timeToIdx[time];
        if (idx === undefined) continue;

        const current = candles[idx];

        let direction = null;
        if (current.close > hl.high) direction = 'BUY';
        else if (current.close < hl.low) direction = 'SELL';
        if (!direction) continue;

        // Momentum: at least 2 candles in last 10 closing past their previous candle
        const lookStart = Math.max(0, idx - 9);
        const recent = candles.slice(lookStart, idx + 1);
        let momentum = 0;
        for (let p = 1; p < recent.length; p++) {
          if (direction === 'BUY' && recent[p].close > recent[p - 1].high) momentum++;
          if (direction === 'SELL' && recent[p].close < recent[p - 1].low) momentum++;
        }
        if (momentum < 2) continue;

        // Wick filter
        const upperWick = current.high - Math.max(current.open, current.close);
        const lowerWick = Math.min(current.open, current.close) - current.low;
        if (direction === 'BUY' && upperWick > lowerWick) continue;
        if (direction === 'SELL' && lowerWick > upperWick) continue;

        const level = direction === 'BUY' ? hl.high : hl.low;
        const score = scoreBreak(current, direction, level);
        const body = Math.abs(current.close - current.open);
        const range = current.high - current.low;
        const wickPct = range > 0 ? Math.round((1 - body / range) * 100) : 100;

        breaks.push({
          pair: inst.replace('_', '/'),
          direction,
          score,
          level,
          close: current.close,
          breakPips: Math.abs(current.close - level),
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
