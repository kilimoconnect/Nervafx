'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

const PAIR_MAP = {
  CHF: { USD: 'USD_CHF', EUR: 'EUR_CHF', GBP: 'GBP_CHF', JPY: 'CHF_JPY', CAD: 'CAD_CHF', AUD: 'AUD_CHF', NZD: 'NZD_CHF' },
  JPY: { USD: 'USD_JPY', EUR: 'EUR_JPY', GBP: 'GBP_JPY', CHF: 'CHF_JPY', CAD: 'CAD_JPY', AUD: 'AUD_JPY', NZD: 'NZD_JPY' },
};
const BASE_OF = {
  USD_CHF: 'USD', EUR_CHF: 'EUR', GBP_CHF: 'GBP', CHF_JPY: 'CHF', CAD_CHF: 'CAD', AUD_CHF: 'AUD', NZD_CHF: 'NZD',
  USD_JPY: 'USD', EUR_JPY: 'EUR', GBP_JPY: 'GBP', CAD_JPY: 'CAD', AUD_JPY: 'AUD', NZD_JPY: 'NZD',
};

function bestTrades(ccy, signal, ranked) {
  const others = ranked.filter(r => r.currency !== ccy && r.currency !== (ccy === 'CHF' ? 'JPY' : 'CHF'));
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
    const days = Math.min(180, parseInt(req.query?.days || '7', 10) || 7);

    let since, until;
    if (date) {
      since = `${date}T00:00:00.000Z`;
      until = `${date}T23:59:59.999Z`;
    } else {
      until = new Date().toISOString();
      since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    }

    const allRows = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('currency_strength')
        .select('time, currency, raw_6h')
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

    const byHour = {};
    for (const r of allRows) {
      const h = r.time;
      if (!byHour[h]) byHour[h] = {};
      byHour[h][r.currency] = parseFloat(r.raw_6h) || 0;
    }

    const hours = Object.keys(byHour).sort();
    const timeline = [];

    for (const hour of hours) {
      const vals = byHour[hour];
      if (Object.keys(vals).length < 8) continue;

      const ranked = CURRENCIES
        .map(c => ({ currency: c, value: vals[c] }))
        .sort((a, b) => b.value - a.value);

      const chfRank = ranked.findIndex(r => r.currency === 'CHF') + 1;
      const jpyRank = ranked.findIndex(r => r.currency === 'JPY') + 1;
      const chfVal = vals.CHF;
      const jpyVal = vals.JPY;

      let chfSignal = null, jpySignal = null;
      if (chfRank === 1 && chfVal > 0.015) chfSignal = 'STRONGEST';
      else if (chfRank === 8 && chfVal < -0.015) chfSignal = 'WEAKEST';
      if (jpyRank === 1 && jpyVal > 0.015) jpySignal = 'STRONGEST';
      else if (jpyRank === 8 && jpyVal < -0.015) jpySignal = 'WEAKEST';

      timeline.push({
        time: hour,
        ranking: ranked,
        chf: { rank: chfRank, value: chfVal, signal: chfSignal, trades: chfSignal ? bestTrades('CHF', chfSignal, ranked) : [] },
        jpy: { rank: jpyRank, value: jpyVal, signal: jpySignal, trades: jpySignal ? bestTrades('JPY', jpySignal, ranked) : [] },
      });
    }

    let chfStreak = 0, chfPrevSig = null;
    let jpyStreak = 0, jpyPrevSig = null;
    for (const t of timeline) {
      if (t.chf.signal && t.chf.signal === chfPrevSig) chfStreak++;
      else chfStreak = t.chf.signal ? 1 : 0;
      chfPrevSig = t.chf.signal;
      t.chf.streak = chfStreak;

      if (t.jpy.signal && t.jpy.signal === jpyPrevSig) jpyStreak++;
      else jpyStreak = t.jpy.signal ? 1 : 0;
      jpyPrevSig = t.jpy.signal;
      t.jpy.streak = jpyStreak;
    }

    const chfStrongest = timeline.filter(t => t.chf.signal === 'STRONGEST').length;
    const chfWeakest   = timeline.filter(t => t.chf.signal === 'WEAKEST').length;
    const jpyStrongest = timeline.filter(t => t.jpy.signal === 'STRONGEST').length;
    const jpyWeakest   = timeline.filter(t => t.jpy.signal === 'WEAKEST').length;

    const signals = timeline.filter(t => {
      if (!t.chf.signal && !t.jpy.signal) return false;
      if (t.chf.signal && t.jpy.signal && t.chf.signal !== t.jpy.signal) return false;
      if (t.chf.signal === 'WEAKEST' && t.jpy.rank <= 4) return false;
      if (t.chf.signal === 'STRONGEST' && t.jpy.rank >= 5) return false;
      if (t.jpy.signal === 'WEAKEST' && t.chf.rank <= 4) return false;
      if (t.jpy.signal === 'STRONGEST' && t.chf.rank >= 5) return false;
      return true;
    });

    res.json({
      since, until,
      totalHours: timeline.length,
      summary: {
        chf: { strongest: chfStrongest, weakest: chfWeakest },
        jpy: { strongest: jpyStrongest, weakest: jpyWeakest },
      },
      signals,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
