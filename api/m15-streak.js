'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(30, parseInt(req.query?.days || '1', 10) || 1);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Need 5 extra M15 bars for lookback
    const fetchSince = new Date(new Date(since).getTime() - 5 * 15 * 60000).toISOString();

    const PAGE = 1000;
    const candleCache = {};

    // Fetch M15 candles for all 28 pairs
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const allData = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'M15')
            .gte('time', fetchSince).lte('time', until)
            .order('time', { ascending: true })
            .range(off, off + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          allData.push(...data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return { inst, data: allData };
      }));
      for (const { inst, data } of results) {
        candleCache[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }


    // Collect unique M15 timestamps, keep only 1 per hour (xx:00) to avoid flooding
    const allTimes = new Set();
    for (const inst of VALID_PAIRS) {
      const candles = candleCache[inst] || [];
      for (const c of candles) {
        if (c.time >= since) allTimes.add(c.time);
      }
    }
    const allSorted = [...allTimes].sort();
    // Keep last M15 bar per hour
    const hourMap = {};
    for (const t of allSorted) {
      const hourKey = t.slice(0, 13);
      hourMap[hourKey] = t;
    }
    const timestamps = Object.values(hourMap).sort();

    const rows = [];

    for (const time of timestamps) {
      const signals = [];

      for (const inst of VALID_PAIRS) {
        const candles = candleCache[inst] || [];
        // Find index of this timestamp
        let idx = -1;
        for (let k = candles.length - 1; k >= 0; k--) {
          if (candles[k].time <= time) { idx = k; break; }
        }
        if (idx < 4) continue;

        let buyCount = 0;
        let sellCount = 0;
        const window = [];
        for (let k = idx - 4; k <= idx; k++) {
          const c = candles[k];
          const bull = c.close > c.open;
          if (bull) buyCount++;
          else sellCount++;
          window.push({
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            direction: bull ? 'BUY' : 'SELL',
          });
        }

        if (buyCount >= 4 || sellCount >= 4) {
          const direction = buyCount >= 4 ? 'BUY' : 'SELL';

          const count = direction === 'BUY' ? buyCount : sellCount;
          const pair = inst.replace('_', '/');

          // Calculate total move over the 5 candles
          const firstOpen = window[0].open;
          const lastClose = window[window.length - 1].close;
          const isJpy = inst.includes('JPY');
          const pipDiv = isJpy ? 0.01 : 0.0001;
          const totalPips = Math.round(((lastClose - firstOpen) / pipDiv) * (direction === 'SELL' ? -1 : 1));

          // Minimum pip filter: 30 pips for GBP pairs, 20 pips for others
          const isGbp = inst.includes('GBP');
          const minPips = isGbp ? 30 : 20;
          if (totalPips < minPips) continue;

          // Average body size
          let bodySum = 0;
          for (const c of window) {
            bodySum += Math.abs(c.close - c.open);
          }
          const avgBody = bodySum / window.length;
          const avgBodyPips = Math.round((avgBody / pipDiv) * 10) / 10;

          signals.push({
            pair,
            instrument: inst,
            direction,
            count,
            totalPips,
            avgBodyPips,
            candles: window,
          });
        }
      }

      if (signals.length > 0) {
        signals.sort((a, b) => b.count - a.count || b.totalPips - a.totalPips);
        rows.push({ time, signals });
      }
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
