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
    // Fetch extra day back to ensure we have day-open prices
    const fetchSince = new Date(new Date(since).getTime() - 24 * 3600000).toISOString();

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
            .select('time, open, close')
            .eq('instrument', inst)
            .eq('timeframe', 'H1')
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
          open: parseFloat(c.open),
          close: parseFloat(c.close),
        }));
      }
    }

    // Forex day starts at 17:00 New York time (NY close)
    // Determine the NY hour for each UTC timestamp
    const nyFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', hour12: false,
    });
    function getNYHour(iso) {
      return parseInt(nyFmt.format(new Date(iso)), 10);
    }
    // Get forex day key: the day resets at 17:00 NY
    // Candles from 17:00 NY onward belong to the NEXT forex day
    const nyDayFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    function forexDayKey(iso) {
      const d = new Date(iso);
      const nyH = getNYHour(iso);
      // If hour >= 17, this candle belongs to the next forex day
      if (nyH >= 17) d.setTime(d.getTime() + 24 * 3600000);
      return nyDayFmt.format(d);
    }

    // Build NY-close reference prices per instrument per forex day
    // The reference = close of the 17:00 NY candle (last candle of previous forex day)
    const closeByInst = {};
    for (const inst of INSTRUMENTS) {
      const m = {};
      for (const c of (candlesByInst[inst] || [])) m[c.time] = c.close;
      closeByInst[inst] = m;
    }

    // Find the 17:00 NY candle close for each forex day per instrument
    const dayRefByInst = {};
    for (const inst of INSTRUMENTS) {
      const refs = {};
      for (const c of (candlesByInst[inst] || [])) {
        const nyH = getNYHour(c.time);
        if (nyH === 17) {
          // This candle's close is the reference for the next forex day
          const fxDay = forexDayKey(c.time);
          refs[fxDay] = c.close;
        }
      }
      dayRefByInst[inst] = refs;
    }

    // Collect all hourly timestamps in range
    const allTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const c of (candlesByInst[inst] || [])) {
        if (c.time >= since && c.time <= until) allTimes.add(c.time);
      }
    }
    const timestamps = [...allTimes].sort();

    const rows = [];
    for (const time of timestamps) {
      const fxDay = forexDayKey(time);
      const strength = {};
      for (const ccy of CURRENCIES) strength[ccy] = 0;

      const pairMoves = {};
      let valid = true;
      for (const inst of INSTRUMENTS) {
        const dayRef = (dayRefByInst[inst] || {})[fxDay];
        const hourClose = (closeByInst[inst] || {})[time];
        if (dayRef === undefined || hourClose === undefined) { valid = false; break; }

        const [base, quote] = inst.split('_');
        const movement = (hourClose - dayRef) / dayRef;
        strength[base] += movement;
        strength[quote] -= movement;
        pairMoves[inst] = movement;
      }
      if (!valid) continue;

      rows.push({ time, values: strength, pairs: pairMoves });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
