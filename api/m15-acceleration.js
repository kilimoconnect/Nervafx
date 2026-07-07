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

    const days = Math.min(30, parseInt(req.query?.days || '1', 10) || 1);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Fetch 1 extra M15 bar for first delta
    const fetchSince = new Date(new Date(since).getTime() - 15 * 60000).toISOString();

    // Fetch M15 currency strength
    const allStrength = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('m15_currency_strength')
        .select('time, values')
        .gte('time', fetchSince)
        .lte('time', until)
        .order('time', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      allStrength.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Fetch hourly 3H smoothed strength for trend confirmation
    const h3Rows = [];
    let h3off = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, smooth_3h')
        .gte('time', fetchSince)
        .lte('time', until)
        .order('time', { ascending: true })
        .range(h3off, h3off + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      h3Rows.push(...data);
      if (data.length < PAGE) break;
      h3off += PAGE;
    }

    const h3ByTime = {};
    for (const r of h3Rows) {
      if (!h3ByTime[r.time]) h3ByTime[r.time] = {};
      h3ByTime[r.time][r.currency] = (parseFloat(r.smooth_3h) || 0) * 10000;
    }
    const h3Timestamps = Object.keys(h3ByTime).sort();

    function getH3(ccy, atTime) {
      let best = null;
      for (let i = h3Timestamps.length - 1; i >= 0; i--) {
        if (h3Timestamps[i] <= atTime) { best = h3ByTime[h3Timestamps[i]]; break; }
      }
      return best ? (best[ccy] || 0) : 0;
    }

    // Fetch M15 candles for all 28 pairs (for break detection)
    const candleSince = new Date(new Date(fetchSince).getTime() - 30 * 60000).toISOString();
    const candleCache = {};
    const ALL_PAIRS = [...VALID_PAIRS];
    for (let b = 0; b < ALL_PAIRS.length; b += 7) {
      const batch = ALL_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const allData = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst).eq('timeframe', 'M15').eq('complete', true)
            .gte('time', candleSince).lte('time', until)
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

    const rows = [];

    for (let t = 1; t < allStrength.length; t++) {
      const cur = allStrength[t];
      const prev = allStrength[t - 1];
      const time = cur.time;

      if (time < since) continue;
      if (!cur.values || !prev.values) continue;

      const curVals = cur.values;
      const prevVals = prev.values;

      // Acceleration = M15 delta of 45M smooth strength (×10000 for display)
      const accels = CURRENCIES.map(ccy => {
        const s = (parseFloat(curVals[ccy]) || 0) * 10000;
        const sp = (parseFloat(prevVals[ccy]) || 0) * 10000;
        const accel = s - sp;
        return {
          currency: ccy,
          acceleration: Math.round(accel * 100) / 100,
          s3: Math.round(s * 100) / 100,
        };
      });

      accels.sort((a, b) => b.acceleration - a.acceleration);

      const maxAbs = Math.max(...accels.map(a => Math.abs(a.acceleration)), 0.01);
      for (const a of accels) {
        a.score = Math.round((a.acceleration / maxAbs) * 100);
      }

      // Rank by strength: top = strongest, bottom = weakest
      const byStrength = [...accels].sort((a, b) => b.s3 - a.s3);
      const topStrong = byStrength.slice(0, 2);
      const topWeak = byStrength.slice(-2).reverse();
      const candidates = [];

      for (const strong of topStrong) {
        for (const weak of topWeak) {
          const fwd = strong.currency + '_' + weak.currency;
          const rev = weak.currency + '_' + strong.currency;
          let inst, pair, direction;
          if (VALID_PAIRS.has(fwd)) {
            inst = fwd;
            pair = strong.currency + '/' + weak.currency;
            direction = 'BUY';
          } else if (VALID_PAIRS.has(rev)) {
            inst = rev;
            pair = weak.currency + '/' + strong.currency;
            direction = 'SELL';
          } else continue;

          // Find latest completed M15 candle at or before this time, and the one before it
          const candles = candleCache[inst] || [];
          let ci = -1;
          for (let k = candles.length - 1; k >= 0; k--) {
            if (candles[k].time <= time) { ci = k; break; }
          }
          if (ci < 1) continue;
          const curr = candles[ci];
          const prevC = candles[ci - 1];

          let broke = false;
          let breakLevel = null;
          const currBody = Math.abs(curr.close - curr.open);
          const prevBody = Math.abs(prevC.close - prevC.open) || 0.00001;
          const bodyPct = Math.round((currBody / prevBody) * 100);
          if (direction === 'BUY' && curr.close > prevC.high) {
            broke = true;
            breakLevel = prevC.high;
          } else if (direction === 'SELL' && curr.close < prevC.low) {
            broke = true;
            breakLevel = prevC.low;
          }
          if (!broke) continue;

          // 3H strength confirmation: strong currency must lead on 3H
          const strong3H = getH3(strong.currency, time);
          const weak3H = getH3(weak.currency, time);
          if (strong3H <= weak3H) continue;

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
            breakLevel,
            bodyPct,
            breakTime: curr.time,
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
