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
      let pair, direction;
      if (VALID_PAIRS.has(fwd)) {
        pair = strongest + '/' + weakest;
        direction = 'BUY';
      } else if (VALID_PAIRS.has(rev)) {
        pair = weakest + '/' + strongest;
        direction = 'SELL';
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
        direction,
        strongest,
        weakest,
        strongVal: { s3: Math.round(ccyData[strongest].s3 * 100) / 100, s4: Math.round(ccyData[strongest].s4 * 100) / 100, s6: Math.round(ccyData[strongest].s6 * 100) / 100 },
        weakVal: { s3: Math.round(ccyData[weakest].s3 * 100) / 100, s4: Math.round(ccyData[weakest].s4 * 100) / 100, s6: Math.round(ccyData[weakest].s6 * 100) / 100 },
        spread: { s3: spread3, s4: spread4, s6: spread6 },
        ranking,
      });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
