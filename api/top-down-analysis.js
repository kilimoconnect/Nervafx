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

// ISO week key (Mon=start)
function weekKey(iso) {
  const d = new Date(iso);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function scoreBreak(c, direction, level) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return 0;
  const bodyRatio = body / range;
  let wickAgainst;
  if (direction === 'BUY') wickAgainst = (c.high - c.close) / range;
  else wickAgainst = (c.close - c.low) / range;
  const breakDist = direction === 'BUY'
    ? (c.close - level) / level : (level - c.close) / level;
  const distScore = Math.min(1, breakDist * 1000);
  const bullish = c.close > c.open;
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
    // Extra days for weekly + daily reference
    const fetchSince = new Date(new Date(since).getTime() - 10 * 24 * 3600000).toISOString();

    // Fetch H1 candles
    const h1ByInst = {};
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
        h1ByInst[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    // Build daily OHLC per instrument
    const dailyOHLC = {};
    for (const inst of INSTRUMENTS) {
      const byDay = {};
      for (const c of (h1ByInst[inst] || [])) {
        const day = forexDayKey(c.time);
        if (!byDay[day]) byDay[day] = { open: c.open, high: c.high, low: c.low, close: c.close };
        else {
          if (c.high > byDay[day].high) byDay[day].high = c.high;
          if (c.low < byDay[day].low) byDay[day].low = c.low;
          byDay[day].close = c.close;
        }
      }
      dailyOHLC[inst] = byDay;
    }

    // Build weekly OHLC per instrument
    const weeklyOHLC = {};
    for (const inst of INSTRUMENTS) {
      const byWeek = {};
      const sorted = Object.entries(dailyOHLC[inst] || {}).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [dayKey, day] of sorted) {
        const d = new Date(dayKey + 'T12:00:00Z');
        const wk = weekKey(dayKey);
        if (!byWeek[wk]) byWeek[wk] = { open: day.open, high: day.high, low: day.low, close: day.close };
        else {
          if (day.high > byWeek[wk].high) byWeek[wk].high = day.high;
          if (day.low < byWeek[wk].low) byWeek[wk].low = day.low;
          byWeek[wk].close = day.close;
        }
      }
      weeklyOHLC[inst] = byWeek;
    }

    // Collect H1 timestamps in range
    const allTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const c of (h1ByInst[inst] || [])) {
        if (c.time >= since && c.time <= until) allTimes.add(c.time);
      }
    }
    const timestamps = [...allTimes].sort();

    // Index H1 candles
    const indexByInst = {};
    for (const inst of INSTRUMENTS) {
      const candles = h1ByInst[inst] || [];
      const timeToIdx = {};
      for (let i = 0; i < candles.length; i++) timeToIdx[candles[i].time] = i;
      indexByInst[inst] = { candles, timeToIdx };
    }

    const rows = [];
    for (const time of timestamps) {
      const fxDay = forexDayKey(time);
      const prevDay = prevTradingDay(fxDay);
      const wk = weekKey(fxDay);
      const pairs = [];

      for (const inst of INSTRUMENTS) {
        const wkOHLC = (weeklyOHLC[inst] || {})[wk];
        const dayOH = (dailyOHLC[inst] || {})[fxDay];
        const prevDayOHLC = (dailyOHLC[inst] || {})[prevDay];

        if (!wkOHLC || !dayOH || !prevDayOHLC) continue;

        // Current weekly direction (using close up to this point)
        const { candles, timeToIdx } = indexByInst[inst];
        const idx = timeToIdx[time];
        if (idx === undefined) continue;
        const currentClose = candles[idx].close;
        const currentCandle = candles[idx];

        // Weekly: use week open vs current close
        const weeklyBuy = currentClose > wkOHLC.open;
        const weeklySell = currentClose < wkOHLC.open;
        const weeklyDir = weeklyBuy ? 'BUY' : weeklySell ? 'SELL' : null;
        if (!weeklyDir) continue;

        // Daily: use day open vs current close
        const dailyBuy = currentClose > dayOH.open;
        const dailySell = currentClose < dayOH.open;
        const dailyDir = dailyBuy ? 'BUY' : dailySell ? 'SELL' : null;
        if (!dailyDir) continue;

        // Weekly and daily must align
        if (weeklyDir !== dailyDir) continue;
        const direction = weeklyDir;

        // Bonus: H1 close broke previous day high (BUY) or low (SELL)
        let h1Break = false;
        let breakScore = 0;
        let breakLevel = null;
        if (direction === 'BUY' && currentClose > prevDayOHLC.high) {
          h1Break = true;
          breakLevel = prevDayOHLC.high;
          breakScore = scoreBreak(currentCandle, direction, breakLevel);
        } else if (direction === 'SELL' && currentClose < prevDayOHLC.low) {
          h1Break = true;
          breakLevel = prevDayOHLC.low;
          breakScore = scoreBreak(currentCandle, direction, breakLevel);
        }

        // Alignment score: weekly + daily aligned = base score
        // + bonus for H1 break
        const weeklyStrength = Math.abs(currentClose - wkOHLC.open) / wkOHLC.open * 10000;
        const dailyStrength = Math.abs(currentClose - dayOH.open) / dayOH.open * 10000;
        let score = Math.round(
          Math.min(40, weeklyStrength * 2) +
          Math.min(40, dailyStrength * 4) +
          (h1Break ? 20 : 0)
        );
        score = Math.min(100, score);

        const body = Math.abs(currentCandle.close - currentCandle.open);
        const range = currentCandle.high - currentCandle.low;
        const wickPct = range > 0 ? Math.round((1 - body / range) * 100) : 100;

        pairs.push({
          pair: inst.replace('_', '/'),
          direction,
          score,
          weeklyDir,
          dailyDir,
          h1Break,
          breakScore,
          breakLevel,
          close: currentClose,
          weekOpen: wkOHLC.open,
          dayOpen: dayOH.open,
          prevHigh: prevDayOHLC.high,
          prevLow: prevDayOHLC.low,
          wickPct,
        });
      }

      if (!pairs.length) continue;
      pairs.sort((a, b) => b.score - a.score);

      rows.push({
        time,
        pairs: pairs.slice(0, 5),
        totalAligned: pairs.length,
      });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 90;
