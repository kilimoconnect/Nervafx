'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

const PAIR_MAP = {
  AUD: { USD: 'AUD_USD', EUR: 'EUR_AUD', GBP: 'GBP_AUD', JPY: 'AUD_JPY', CHF: 'AUD_CHF', CAD: 'AUD_CAD', NZD: 'AUD_NZD' },
  NZD: { USD: 'NZD_USD', EUR: 'EUR_NZD', GBP: 'GBP_NZD', JPY: 'NZD_JPY', CHF: 'NZD_CHF', CAD: 'NZD_CAD', AUD: 'AUD_NZD' },
};
const BASE_OF = {
  AUD_USD: 'AUD', EUR_AUD: 'EUR', GBP_AUD: 'GBP', AUD_JPY: 'AUD', AUD_CHF: 'AUD', AUD_CAD: 'AUD', AUD_NZD: 'AUD',
  NZD_USD: 'NZD', EUR_NZD: 'EUR', GBP_NZD: 'GBP', NZD_JPY: 'NZD', NZD_CHF: 'NZD', NZD_CAD: 'NZD',
};

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

    const date = req.query?.date;  // YYYY-MM-DD
    const days = Math.min(180, parseInt(req.query?.days || '7', 10) || 7);

    let since, until;
    if (date) {
      since = `${date}T00:00:00.000Z`;
      until = `${date}T23:59:59.999Z`;
    } else {
      until = new Date().toISOString();
      since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    }

    // Fetch raw_12h (unsmoothed) for all currencies in range
    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, raw_12h')
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

    // Group by hour
    const byHour = {};
    for (const r of allRows) {
      const h = r.time;
      if (!byHour[h]) byHour[h] = {};
      byHour[h][r.currency] = parseFloat(r.raw_12h) || 0;
    }

    const hours = Object.keys(byHour).sort();
    const timeline = [];

    for (const hour of hours) {
      const vals = byHour[hour];
      if (Object.keys(vals).length < 8) continue;

      // Rank currencies by raw_12h (strongest first)
      const ranked = CURRENCIES
        .map(c => ({ currency: c, value: vals[c] }))
        .sort((a, b) => b.value - a.value);

      const audRank = ranked.findIndex(r => r.currency === 'AUD') + 1;
      const nzdRank = ranked.findIndex(r => r.currency === 'NZD') + 1;
      const audVal = vals.AUD;
      const nzdVal = vals.NZD;

      // Signal: strongest (rank 1) or weakest (rank 8)
      let audSignal = null, nzdSignal = null;
      if (audRank === 1) audSignal = 'STRONGEST';
      else if (audRank === 8) audSignal = 'WEAKEST';
      if (nzdRank === 1) nzdSignal = 'STRONGEST';
      else if (nzdRank === 8) nzdSignal = 'WEAKEST';

      timeline.push({
        time: hour,
        ranking: ranked,
        aud: { rank: audRank, value: audVal, signal: audSignal, trades: audSignal ? bestTrades('AUD', audSignal, ranked) : [] },
        nzd: { rank: nzdRank, value: nzdVal, signal: nzdSignal, trades: nzdSignal ? bestTrades('NZD', nzdSignal, ranked) : [] },
      });
    }

    // Summary stats
    const audStrongest = timeline.filter(t => t.aud.signal === 'STRONGEST').length;
    const audWeakest   = timeline.filter(t => t.aud.signal === 'WEAKEST').length;
    const nzdStrongest = timeline.filter(t => t.nzd.signal === 'STRONGEST').length;
    const nzdWeakest   = timeline.filter(t => t.nzd.signal === 'WEAKEST').length;

    // Signal events (hours where AUD or NZD hit rank 1 or 8)
    const signals = timeline.filter(t => t.aud.signal || t.nzd.signal);

    res.json({
      since, until,
      totalHours: timeline.length,
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
