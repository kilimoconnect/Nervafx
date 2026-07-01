'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const INSTRUMENTS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

const MIN_CONSECUTIVE = 3;
const MIN_BODY_RATIO = 0.75;

function pipSize(inst) {
  return inst.includes('JPY') ? 0.01 : 0.0001;
}

function detectImpulses(candles, inst) {
  const results = [];
  if (candles.length < MIN_CONSECUTIVE) return results;

  const pip = pipSize(inst);
  let i = 0;

  while (i < candles.length) {
    const c = candles[i];
    const dir = c.close > c.open ? 'BUY' : c.close < c.open ? 'SELL' : null;
    if (!dir) { i++; continue; }

    let count = 0;
    let bodyRatioSum = 0;
    let j = i;

    while (j < candles.length) {
      const cc = candles[j];
      const range = cc.high - cc.low;
      if (range <= 0) break;
      const body = Math.abs(cc.close - cc.open);
      const bodyRatio = body / range;
      const candleDir = cc.close > cc.open ? 'BUY' : cc.close < cc.open ? 'SELL' : null;
      if (candleDir !== dir) break;
      if (bodyRatio < 0.40) break;
      count++;
      bodyRatioSum += bodyRatio;
      j++;
    }

    if (count >= MIN_CONSECUTIVE && (bodyRatioSum / count) >= MIN_BODY_RATIO) {
      const start = candles[i];
      const end = candles[j - 1];
      const moveRaw = dir === 'BUY'
        ? end.close - start.open
        : start.open - end.close;

      results.push({
        time: start.time,
        endTime: end.time,
        pair: inst.replace('_', '/'),
        direction: dir,
        count,
        avgBodyPct: Math.round((bodyRatioSum / count) * 100),
        movePips: Math.round((moveRaw / pip) * 10) / 10,
        openPrice: start.open,
        closePrice: end.close,
      });
      i = j;
    } else {
      i++;
    }
  }

  return results;
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

    const allSignals = [];

    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
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
            .gte('time', since)
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
        if (!data.length) continue;
        const candles = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
        allSignals.push(...detectImpulses(candles, inst));
      }
    }

    // Group by start hour so one card can hold multiple pairs
    const byHour = {};
    for (const s of allSignals) {
      const hk = s.time.slice(0, 13); // YYYY-MM-DDTHH
      if (!byHour[hk]) byHour[hk] = { time: s.time.slice(0, 13) + ':00:00Z', pairs: [] };
      byHour[hk].pairs.push(s);
    }

    const rows = Object.values(byHour)
      .sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

    // Sort pairs within each hour by pips descending
    for (const row of rows) {
      row.pairs.sort((a, b) => b.movePips - a.movePips);
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
