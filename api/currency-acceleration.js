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

    // Fetch 1 extra hour for first delta
    const fetchSince = new Date(new Date(since).getTime() - 3600000).toISOString();

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

      // Acceleration = hourly delta of 3H strength
      const accels = CURRENCIES.map(ccy => {
        const s3now = cur[ccy]?.s3 || 0;
        const s3prev = prev[ccy]?.s3 || 0;
        const accel = s3now - s3prev;
        return {
          currency: ccy,
          acceleration: Math.round(accel * 100) / 100,
          s3: Math.round(s3now * 100) / 100,
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

      // Confirmed strong: 3H > 0 AND acceleration > 0 (strong and getting stronger)
      const confirmed_strong = accels.filter(a => a.s3 > 0 && a.acceleration > 0);
      // Confirmed weak: 3H < 0 AND acceleration < 0 (weak and getting weaker)
      const confirmed_weak = accels.filter(a => a.s3 < 0 && a.acceleration < 0);

      // Sort strong by 3H descending, weak by 3H ascending
      confirmed_strong.sort((a, b) => b.s3 - a.s3);
      confirmed_weak.sort((a, b) => a.s3 - b.s3);

      const candidates = [];
      const topStrong = confirmed_strong.slice(0, 3);
      const topWeak = confirmed_weak.slice(0, 3);

      for (const strong of topStrong) {
        for (const weak of topWeak) {
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

          const spread = Math.round((strong.s3 - weak.s3) * 100) / 100;
          candidates.push({
            pair,
            direction,
            strongCcy: strong.currency,
            weakCcy: weak.currency,
            strongS3: strong.s3,
            weakS3: weak.s3,
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
