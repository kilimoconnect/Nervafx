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

    // Fetch currency_strength with 1 extra hour for first delta
    const fetchSince = new Date(new Date(since).getTime() - 2 * 3600000).toISOString();

    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, smooth_3h, smooth_4h, smooth_6h')
        .gte('time', fetchSince)
        .lte('time', until)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allRows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Group by time
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

    for (let t = 1; t < timestamps.length; t++) {
      const time = timestamps[t];
      const prevTime = timestamps[t - 1];

      // Skip if before requested range (we fetched extra for first delta)
      if (time < since) continue;

      const cur = byTime[time];
      const prev = byTime[prevTime];
      if (!cur || !prev) continue;
      if (Object.keys(cur).length < 8 || Object.keys(prev).length < 8) continue;

      // Calculate acceleration per currency (delta of 6H strength between hours)
      const accels = CURRENCIES.map(ccy => {
        const curVal = cur[ccy]?.s6 || 0;
        const prevVal = prev[ccy]?.s6 || 0;
        return {
          currency: ccy,
          current: Math.round(curVal * 100) / 100,
          previous: Math.round(prevVal * 100) / 100,
          acceleration: Math.round((curVal - prevVal) * 100) / 100,
          s3: Math.round((cur[ccy]?.s3 || 0) * 100) / 100,
          s4: Math.round((cur[ccy]?.s4 || 0) * 100) / 100,
          s6: Math.round((cur[ccy]?.s6 || 0) * 100) / 100,
        };
      });

      // Rank by acceleration descending
      accels.sort((a, b) => b.acceleration - a.acceleration);

      // Normalize to ±100 score
      const maxAbs = Math.max(...accels.map(a => Math.abs(a.acceleration)), 0.01);
      for (const a of accels) {
        a.score = Math.round((a.acceleration / maxAbs) * 100);
      }

      // Generate candidate pairs: top 2 accelerators vs bottom 2
      const top2 = accels.slice(0, 2);
      const bot2 = accels.slice(-2).reverse();
      const candidates = [];

      for (const strong of top2) {
        for (const weak of bot2) {
          const fwd = strong.currency + '_' + weak.currency;
          const rev = weak.currency + '_' + strong.currency;
          let pair, direction;
          if (VALID_PAIRS.has(fwd)) {
            pair = strong.currency + '/' + weak.currency;
            direction = 'BUY';
          } else if (VALID_PAIRS.has(rev)) {
            pair = weak.currency + '/' + strong.currency;
            direction = 'SELL';
          } else continue;

          const spread = Math.round((strong.acceleration - weak.acceleration) * 100) / 100;
          candidates.push({
            pair,
            direction,
            strongCcy: strong.currency,
            weakCcy: weak.currency,
            strongAccel: strong.acceleration,
            weakAccel: weak.acceleration,
            spread,
            strongScore: strong.score,
            weakScore: weak.score,
          });
        }
      }

      candidates.sort((a, b) => b.spread - a.spread);

      rows.push({
        time,
        ranking: accels,
        candidates,
      });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
