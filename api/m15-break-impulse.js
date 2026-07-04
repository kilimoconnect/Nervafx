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

const GBP_PAIRS = new Set([
  'GBP_USD','EUR_GBP','GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
]);

function isJpy(inst) { return inst.includes('JPY'); }
function pipDiv(inst) { return isJpy(inst) ? 0.01 : 0.0001; }

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

    const fetchSince = new Date(new Date(since).getTime() - 15 * 60000).toISOString();

    const PAGE = 1000;
    const candleCache = {};

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

    // Collect all M15 timestamps in range
    const allTimes = new Set();
    for (const inst of VALID_PAIRS) {
      const candles = candleCache[inst] || [];
      for (const c of candles) {
        if (c.time >= since) allTimes.add(c.time);
      }
    }
    const timestamps = [...allTimes].sort();

    const rows = [];

    for (const time of timestamps) {
      const signals = [];

      for (const inst of VALID_PAIRS) {
        const candles = candleCache[inst] || [];
        let idx = -1;
        for (let k = candles.length - 1; k >= 0; k--) {
          if (candles[k].time <= time) { idx = k; break; }
        }
        if (idx < 1) continue;

        const curr = candles[idx];
        const prev = candles[idx - 1];

        const body = Math.abs(curr.close - curr.open);
        const pd = pipDiv(inst);
        const bodyPips = Math.round((body / pd) * 10) / 10;

        const minPips = GBP_PAIRS.has(inst) ? 15 : 10;
        if (bodyPips < minPips) continue;

        let direction = null;
        if (curr.close > curr.open && curr.close > prev.high) {
          direction = 'BUY';
        } else if (curr.close < curr.open && curr.close < prev.low) {
          direction = 'SELL';
        }
        if (!direction) continue;

        const breakPips = direction === 'BUY'
          ? Math.round(((curr.close - prev.high) / pd) * 10) / 10
          : Math.round(((prev.low - curr.close) / pd) * 10) / 10;

        const pair = inst.replace('_', '/');

        signals.push({
          pair,
          instrument: inst,
          direction,
          bodyPips,
          breakPips,
          minPips,
          prevHigh: prev.high,
          prevLow: prev.low,
          candle: {
            time: curr.time,
            open: curr.open,
            high: curr.high,
            low: curr.low,
            close: curr.close,
          },
          prevCandle: {
            time: prev.time,
            open: prev.open,
            high: prev.high,
            low: prev.low,
            close: prev.close,
          },
        });
      }

      if (signals.length > 0) {
        signals.sort((a, b) => b.bodyPips - a.bodyPips);
        rows.push({ time, signals });
      }
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
