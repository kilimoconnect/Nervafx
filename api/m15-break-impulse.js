'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');
const { fetchDailyDirectionMap, getDirectionForTime } = require('./_daily-direction');

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

    const days = Math.min(365, parseInt(req.query?.days || '1', 10) || 1);
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

    // Per-day daily continuation direction map (works for historical date ranges)
    const dailyDirectionMap = await fetchDailyDirectionMap(sb, VALID_PAIRS, since, until);

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
        const pd = pipDiv(inst);
        const minPips = GBP_PAIRS.has(inst) ? 30 : 20;

        // Check single candle break
        const body1 = Math.abs(curr.close - curr.open);
        const body1Pips = Math.round((body1 / pd) * 10) / 10;

        let direction = null;
        let bodyPips = 0;
        let candleCount = 0;
        let breakRef = prev; // candle whose high/low is being broken

        if (body1Pips >= minPips) {
          // Single candle meets threshold
          if (curr.close > curr.open && curr.close > prev.high) {
            direction = 'BUY'; bodyPips = body1Pips; candleCount = 1;
          } else if (curr.close < curr.open && curr.close < prev.low) {
            direction = 'SELL'; bodyPips = body1Pips; candleCount = 1;
          }
        }

        // Check two consecutive candles if single didn't qualify
        if (!direction && idx >= 2) {
          const prev2 = candles[idx - 2];
          const prevC = candles[idx - 1];
          const prevBull = prevC.close > prevC.open;
          const currBull = curr.close > curr.open;

          if (prevBull && currBull) {
            const combined = Math.abs(prevC.close - prevC.open) + Math.abs(curr.close - curr.open);
            const combinedPips = Math.round((combined / pd) * 10) / 10;
            if (combinedPips >= minPips && curr.close > prev2.high) {
              direction = 'BUY'; bodyPips = combinedPips; candleCount = 2;
              breakRef = prev2;
            }
          } else if (!prevBull && !currBull) {
            const combined = Math.abs(prevC.close - prevC.open) + Math.abs(curr.close - curr.open);
            const combinedPips = Math.round((combined / pd) * 10) / 10;
            if (combinedPips >= minPips && curr.close < prev2.low) {
              direction = 'SELL'; bodyPips = combinedPips; candleCount = 2;
              breakRef = prev2;
            }
          }
        }

        if (!direction) continue;

        // Daily continuation filter (per-day, matches historical timestamps)
        const dc = getDirectionForTime(dailyDirectionMap, inst, time);
        if (!dc || dc.direction !== direction) continue;

        const breakPips = direction === 'BUY'
          ? Math.round(((curr.close - breakRef.high) / pd) * 10) / 10
          : Math.round(((breakRef.low - curr.close) / pd) * 10) / 10;

        const pair = inst.replace('_', '/');

        const sig = {
          pair,
          instrument: inst,
          direction,
          bodyPips,
          breakPips,
          minPips,
          candleCount,
          prevHigh: breakRef.high,
          prevLow: breakRef.low,
          candle: {
            time: curr.time,
            open: curr.open,
            high: curr.high,
            low: curr.low,
            close: curr.close,
          },
          prevCandle: {
            time: breakRef.time,
            open: breakRef.open,
            high: breakRef.high,
            low: breakRef.low,
            close: breakRef.close,
          },
        };

        // Include the middle candle for 2-candle breaks
        if (candleCount === 2) {
          const mid = candles[idx - 1];
          sig.midCandle = {
            time: mid.time,
            open: mid.open,
            high: mid.high,
            low: mid.low,
            close: mid.close,
          };
        }

        signals.push(sig);
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
