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

const PAIR_MAP = {
  AUD: { USD: 'AUD_USD', EUR: 'EUR_AUD', GBP: 'GBP_AUD', JPY: 'AUD_JPY', CHF: 'AUD_CHF', CAD: 'AUD_CAD', NZD: 'AUD_NZD' },
  NZD: { USD: 'NZD_USD', EUR: 'EUR_NZD', GBP: 'GBP_NZD', JPY: 'NZD_JPY', CHF: 'NZD_CHF', CAD: 'NZD_CAD', AUD: 'AUD_NZD' },
};
const BASE_OF = {
  AUD_USD: 'AUD', EUR_AUD: 'EUR', GBP_AUD: 'GBP', AUD_JPY: 'AUD', AUD_CHF: 'AUD', AUD_CAD: 'AUD', AUD_NZD: 'AUD',
  NZD_USD: 'NZD', EUR_NZD: 'EUR', GBP_NZD: 'GBP', NZD_JPY: 'NZD', NZD_CHF: 'NZD', NZD_CAD: 'NZD',
};

const LOOKBACK = 24; // 24 M15 candles = 6 hours

function bestTrades(ccy, signal, ranked) {
  const others = ranked.filter(r => r.currency !== ccy && r.currency !== (ccy === 'AUD' ? 'NZD' : 'AUD'));
  const targets = signal === 'STRONGEST' ? others.slice(-3).reverse() : others.slice(0, 3);
  return targets.map(t => {
    const pair = PAIR_MAP[ccy][t.currency];
    const isBase = BASE_OF[pair] === ccy;
    const direction = signal === 'STRONGEST'
      ? (isBase ? 'BUY' : 'SELL')
      : (isBase ? 'SELL' : 'BUY');
    return { pair: pair.replace('_', '/'), direction, vs: t.currency, vsRank: ranked.indexOf(t) + 1 };
  });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const date = req.query?.date;
    const days = Math.min(30, parseInt(req.query?.days || '7', 10) || 7);

    let since, until;
    if (date) {
      since = `${date}T00:00:00.000Z`;
      until = `${date}T23:59:59.999Z`;
    } else {
      until = new Date().toISOString();
      since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    }

    // Need extra candles for lookback
    const fetchSince = new Date(new Date(since).getTime() - LOOKBACK * 15 * 60 * 1000).toISOString();

    // Fetch M15 candles for all 28 instruments
    const candlesByInst = {};
    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async (inst) => {
        const allData = [];
        const PAGE = 1000;
        let offset = 0;
        while (true) {
          let q = sb
            .from('backtest_candles')
            .select('time, close')
            .eq('instrument', inst)
            .eq('timeframe', 'M15')
            .eq('complete', true)
            .gte('time', fetchSince);
          if (until) q = q.lte('time', until);
          const { data, error } = await q
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

    // Build lookup: { instrument: { isoTime: close } }
    const lookup = {};
    for (const inst of INSTRUMENTS) {
      lookup[inst] = {};
      for (const c of (candlesByInst[inst] || [])) {
        lookup[inst][c.time] = c.close;
      }
    }

    // Collect all M15 timestamps within the actual range
    const allTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const c of (candlesByInst[inst] || [])) {
        if (c.time >= since && (!until || c.time <= until)) {
          allTimes.add(c.time);
        }
      }
    }
    const timestamps = [...allTimes].sort();

    // Compute strength at each M15 timestamp
    const timeline = [];
    for (const time of timestamps) {
      const strength = {};
      for (const ccy of CURRENCIES) strength[ccy] = 0;

      let valid = true;
      for (const inst of INSTRUMENTS) {
        const [base, quote] = inst.split('_');
        const closeNow = lookup[inst][time];
        if (closeNow === undefined) { valid = false; break; }

        // Find candle LOOKBACK periods back
        const pastTime = new Date(new Date(time).getTime() - LOOKBACK * 15 * 60 * 1000).toISOString();
        const pastClose = lookup[inst][pastTime];
        if (pastClose === undefined) { valid = false; break; }

        const movement = (closeNow - pastClose) / pastClose;
        strength[base] += movement;
        strength[quote] -= movement;
      }
      if (!valid) continue;

      const ranked = CURRENCIES
        .map(c => ({ currency: c, value: strength[c] }))
        .sort((a, b) => b.value - a.value);

      const audRank = ranked.findIndex(r => r.currency === 'AUD') + 1;
      const nzdRank = ranked.findIndex(r => r.currency === 'NZD') + 1;
      const audVal = strength.AUD;
      const nzdVal = strength.NZD;

      let audSignal = null, nzdSignal = null;
      if (audRank === 1 && audVal > 0.02) audSignal = 'STRONGEST';
      else if (audRank === 8 && audVal < -0.02) audSignal = 'WEAKEST';
      if (nzdRank === 1 && nzdVal > 0.02) nzdSignal = 'STRONGEST';
      else if (nzdRank === 8 && nzdVal < -0.02) nzdSignal = 'WEAKEST';

      timeline.push({
        time,
        ranking: ranked,
        aud: { rank: audRank, value: audVal, signal: audSignal, trades: audSignal ? bestTrades('AUD', audSignal, ranked) : [] },
        nzd: { rank: nzdRank, value: nzdVal, signal: nzdSignal, trades: nzdSignal ? bestTrades('NZD', nzdSignal, ranked) : [] },
      });
    }

    // Summary
    const audStrongest = timeline.filter(t => t.aud.signal === 'STRONGEST').length;
    const audWeakest = timeline.filter(t => t.aud.signal === 'WEAKEST').length;
    const nzdStrongest = timeline.filter(t => t.nzd.signal === 'STRONGEST').length;
    const nzdWeakest = timeline.filter(t => t.nzd.signal === 'WEAKEST').length;

    // Signal events — hide AUD/NZD conflicts
    const signals = timeline.filter(t => {
      if (!t.aud.signal && !t.nzd.signal) return false;
      if (t.aud.signal && t.nzd.signal && t.aud.signal !== t.nzd.signal) return false;
      return true;
    });

    res.json({
      since, until,
      totalBars: timeline.length,
      summary: {
        aud: { strongest: audStrongest, weakest: audWeakest },
        nzd: { strongest: nzdStrongest, weakest: nzdWeakest },
      },
      signals,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
