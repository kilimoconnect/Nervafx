'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
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

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const days = Math.min(30, parseInt(req.query?.days || '2', 10) || 2);
    const until = new Date().toISOString();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const fetchSince = new Date(new Date(since).getTime() - LOOKBACK * 15 * 60 * 1000).toISOString();

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
            .eq('timeframe', 'M15')
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
          close: parseFloat(c.close),
        }));
      }
    }

    const indexByInst = {};
    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst] || [];
      const timeToIdx = {};
      for (let i = 0; i < candles.length; i++) timeToIdx[candles[i].time] = i;
      indexByInst[inst] = { candles, timeToIdx };
    }

    const allTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const c of (candlesByInst[inst] || [])) {
        if (c.time >= since && c.time <= until) allTimes.add(c.time);
      }
    }
    const timestamps = [...allTimes].sort();

    const rows = [];
    for (const time of timestamps) {
      const strength = {};
      for (const ccy of CURRENCIES) strength[ccy] = 0;

      let valid = true;
      for (const inst of INSTRUMENTS) {
        const { candles, timeToIdx } = indexByInst[inst];
        const idx = timeToIdx[time];
        if (idx === undefined || idx < LOOKBACK) { valid = false; break; }

        const [base, quote] = inst.split('_');
        const closeNow = candles[idx].close;
        const closePast = candles[idx - LOOKBACK].close;

        const movement = (closeNow - closePast) / closePast;
        strength[base] += movement;
        strength[quote] -= movement;
      }
      if (!valid) continue;

      rows.push({ time, values: strength });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
