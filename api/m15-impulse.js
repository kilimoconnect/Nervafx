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

const NY_CLOSE_UTC = 21;
const MIN_CONSECUTIVE = 3;
const MIN_BODY_RATIO = 0.80;

function pipSize(inst) {
  return inst.includes('JPY') ? 0.01 : 0.0001;
}

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

    const fetchSince = new Date(new Date(since).getTime() - 5 * 86400000).toISOString();
    const allSignals = [];

    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const [m15Res, h1Res] = await Promise.all([
          (async () => {
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
            return allData;
          })(),
          (async () => {
            const { data, error } = await sb
              .from('backtest_candles')
              .select('time, open, high, low, close')
              .eq('instrument', inst)
              .eq('timeframe', 'H1')
              .eq('complete', true)
              .gte('time', fetchSince)
              .lte('time', until)
              .order('time', { ascending: true })
              .limit(1000);
            if (error) return [];
            return data || [];
          })(),
        ]);
        return { inst, m15: m15Res, h1: h1Res };
      }));

      for (const { inst, m15, h1 } of results) {
        if (!m15.length) continue;

        // Build daily OHLC from H1
        const dailyOHLC = {};
        for (const c of h1) {
          const o = parseFloat(c.open), h = parseFloat(c.high), l = parseFloat(c.low), cl = parseFloat(c.close);
          const day = forexDayKey(c.time);
          if (!dailyOHLC[day]) dailyOHLC[day] = { open: o, high: h, low: l, close: cl };
          else {
            if (h > dailyOHLC[day].high) dailyOHLC[day].high = h;
            if (l < dailyOHLC[day].low) dailyOHLC[day].low = l;
            dailyOHLC[day].close = cl;
          }
        }

        const candles = m15.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
        const impulses = detectImpulses(candles, inst);

        // Filter: impulse close must break previous day high (BUY) or low (SELL)
        for (const imp of impulses) {
          const fxDay = forexDayKey(imp.endTime);
          const prevDay = prevTradingDay(fxDay);
          const prev = dailyOHLC[prevDay];
          if (!prev) continue;

          if (imp.direction === 'BUY' && imp.closePrice > prev.high) {
            imp.breakLevel = prev.high;
            allSignals.push(imp);
          } else if (imp.direction === 'SELL' && imp.closePrice < prev.low) {
            imp.breakLevel = prev.low;
            allSignals.push(imp);
          }
        }
      }
    }

    allSignals.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : b.movePips - a.movePips);

    res.json({ rows: allSignals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
