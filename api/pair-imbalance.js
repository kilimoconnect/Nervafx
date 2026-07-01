'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const VALID_PAIRS = new Set([
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
]);

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

    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, smooth_3h, smooth_4h, smooth_6h')
        .gte('time', since)
        .lte('time', until)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    const byTime = {};
    for (const r of allRows) {
      if (!byTime[r.time]) byTime[r.time] = {};
      byTime[r.time][r.currency] = {
        s3: (parseFloat(r.smooth_3h) || 0) * 10000,
        s4: (parseFloat(r.smooth_4h) || 0) * 10000,
        s6: (parseFloat(r.smooth_6h) || 0) * 10000,
      };
    }

    const timestamps = Object.keys(byTime).sort();
    const rows = [];

    for (const time of timestamps) {
      const ccyData = byTime[time];
      if (Object.keys(ccyData).length < 8) continue;

      // For each TF find strongest and weakest
      const tfs = ['s3', 's4', 's6'];
      const tfResults = tfs.map(tf => {
        let best = null, worst = null;
        for (const ccy of CURRENCIES) {
          const v = ccyData[ccy]?.[tf] || 0;
          if (!best || v > best.v) best = { cur: ccy, v };
          if (!worst || v < worst.v) worst = { cur: ccy, v };
        }
        return { best, worst };
      });

      const strongest = tfResults[0].best.cur;
      const weakest = tfResults[0].worst.cur;
      if (strongest === weakest) continue;
      const aligned = tfResults.every(r => r.best.cur === strongest && r.worst.cur === weakest);
      if (!aligned) continue;

      // Build pair
      const fwd = strongest + '_' + weakest;
      const rev = weakest + '_' + strongest;
      let pair, direction, instrument;
      if (VALID_PAIRS.has(fwd)) {
        pair = strongest + '/' + weakest;
        direction = 'BUY';
        instrument = fwd;
      } else if (VALID_PAIRS.has(rev)) {
        pair = weakest + '/' + strongest;
        direction = 'SELL';
        instrument = rev;
      } else continue;

      // All 8 currencies ranked
      const ranking = CURRENCIES
        .map(c => ({ cur: c, v3: Math.round((ccyData[c]?.s3 || 0) * 100) / 100, v4: Math.round((ccyData[c]?.s4 || 0) * 100) / 100, v6: Math.round((ccyData[c]?.s6 || 0) * 100) / 100 }))
        .sort((a, b) => b.v6 - a.v6);

      const spread3 = Math.round((ccyData[strongest].s3 - ccyData[weakest].s3) * 100) / 100;
      const spread4 = Math.round((ccyData[strongest].s4 - ccyData[weakest].s4) * 100) / 100;
      const spread6 = Math.round((ccyData[strongest].s6 - ccyData[weakest].s6) * 100) / 100;

      rows.push({
        time,
        pair,
        instrument,
        direction,
        strongest,
        weakest,
        strongVal: { s3: Math.round(ccyData[strongest].s3 * 100) / 100, s4: Math.round(ccyData[strongest].s4 * 100) / 100, s6: Math.round(ccyData[strongest].s6 * 100) / 100 },
        weakVal: { s3: Math.round(ccyData[weakest].s3 * 100) / 100, s4: Math.round(ccyData[weakest].s4 * 100) / 100, s6: Math.round(ccyData[weakest].s6 * 100) / 100 },
        spread: { s3: spread3, s4: spread4, s6: spread6 },
        ranking,
        h1Break: false,
        breakLevel: null,
      });
    }

    // Fetch H1 candles for matched instruments to check previous day high/low break
    const instruments = [...new Set(rows.map(r => r.instrument))];
    const candlesByInst = {};
    for (let b = 0; b < instruments.length; b += 7) {
      const batch = instruments.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst)
          .eq('timeframe', 'H1')
          .eq('complete', true)
          .gte('time', new Date(new Date(since).getTime() - 5 * 86400000).toISOString())
          .lte('time', until)
          .order('time', { ascending: true })
          .limit(1000);
        if (error) return { inst, data: [] };
        return { inst, data: data || [] };
      }));
      for (const { inst, data } of results) {
        // Build daily OHLC
        const byDay = {};
        const byTime = {};
        for (const c of data) {
          const o = parseFloat(c.open), h = parseFloat(c.high), l = parseFloat(c.low), cl = parseFloat(c.close);
          const day = forexDayKey(c.time);
          if (!byDay[day]) byDay[day] = { open: o, high: h, low: l, close: cl };
          else {
            if (h > byDay[day].high) byDay[day].high = h;
            if (l < byDay[day].low) byDay[day].low = l;
            byDay[day].close = cl;
          }
          byTime[c.time] = cl;
        }
        candlesByInst[inst] = { byDay, byTime };
      }
    }

    // Check each row for previous day break
    for (const row of rows) {
      const cd = candlesByInst[row.instrument];
      if (!cd) continue;
      const fxDay = forexDayKey(row.time);
      const prevDay = prevTradingDay(fxDay);
      const prevOHLC = cd.byDay[prevDay];
      if (!prevOHLC) continue;
      const price = cd.byTime[row.time];
      if (!price) continue;

      if (row.direction === 'BUY' && price > prevOHLC.high) {
        row.h1Break = true;
        row.breakLevel = prevOHLC.high;
      } else if (row.direction === 'SELL' && price < prevOHLC.low) {
        row.h1Break = true;
        row.breakLevel = prevOHLC.low;
      }
    }

    // Remove instrument from response
    for (const row of rows) delete row.instrument;

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
