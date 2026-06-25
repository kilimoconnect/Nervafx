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
  CHF: { USD: 'USD_CHF', EUR: 'EUR_CHF', GBP: 'GBP_CHF', JPY: 'CHF_JPY', CAD: 'CAD_CHF', AUD: 'AUD_CHF', NZD: 'NZD_CHF' },
  JPY: { USD: 'USD_JPY', EUR: 'EUR_JPY', GBP: 'GBP_JPY', CHF: 'CHF_JPY', CAD: 'CAD_JPY', AUD: 'AUD_JPY', NZD: 'NZD_JPY' },
};
const BASE_OF = {
  USD_CHF: 'USD', EUR_CHF: 'EUR', GBP_CHF: 'GBP', CHF_JPY: 'CHF', CAD_CHF: 'CAD', AUD_CHF: 'AUD', NZD_CHF: 'NZD',
  USD_JPY: 'USD', EUR_JPY: 'EUR', GBP_JPY: 'GBP', CAD_JPY: 'CAD', AUD_JPY: 'AUD', NZD_JPY: 'NZD',
};

const LOOKBACK = 10;
const Q_CANDLES = 10;

function computeQuality(candles) {
  if (candles.length < Q_CANDLES) return null;
  const c = candles.slice(-Q_CANDLES);

  const bullCandles = c.filter(x => x.close > x.open).length;
  const bearCandles = c.filter(x => x.close < x.open).length;
  const directionScore = ((bullCandles - bearCandles) / Q_CANDLES) * 100;
  const mainDir = directionScore > 0 ? 'BULLISH' : directionScore < 0 ? 'BEARISH' : 'NEUTRAL';

  const netMove = Math.abs(c[Q_CANDLES - 1].close - c[0].open);
  const totalRange = c.reduce((s, x) => s + (x.high - x.low), 0);
  const impulseStrength = totalRange > 0 ? (netMove / totalRange) * 100 : 0;

  const totalWick = c.reduce((s, x) => {
    const body = Math.abs(x.close - x.open);
    return s + (x.high - x.low - body);
  }, 0);
  const wickCleanliness = totalRange > 0 ? 100 - (totalWick / totalRange) * 100 : 0;

  const quality = Math.round(
    0.15 * Math.abs(directionScore) +
    0.80 * impulseStrength +
    0.05 * wickCleanliness
  );

  return { direction: mainDir, quality };
}

function bestTrades(ccy, signal, ranked, ohlcByInst, time) {
  const others = ranked.filter(r => r.currency !== ccy && r.currency !== (ccy === 'CHF' ? 'JPY' : 'CHF'));
  const targets = signal === 'STRONGEST' ? others.slice(-3).reverse() : others.slice(0, 3);
  return targets.map(t => {
    const pair = PAIR_MAP[ccy][t.currency];
    const isBase = BASE_OF[pair] === ccy;
    const direction = signal === 'STRONGEST'
      ? (isBase ? 'BUY' : 'SELL')
      : (isBase ? 'SELL' : 'BUY');

    let score = null, pairDir = null;
    const instData = ohlcByInst[pair];
    if (instData) {
      const idx = instData.timeToIdx[time];
      if (idx !== undefined && idx >= Q_CANDLES - 1) {
        const slice = instData.candles.slice(idx - Q_CANDLES + 1, idx + 1);
        const q = computeQuality(slice);
        if (q) {
          score = q.quality;
          pairDir = q.direction;
        }
      }
    }

    return { pair: pair.replace('_', '/'), direction, vs: t.currency, vsRank: ranked.indexOf(t) + 1, score, pairDir };
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

    const fetchSince = new Date(new Date(since).getTime() - LOOKBACK * 15 * 60 * 1000).toISOString();

    const candlesByInst = {};
    const ohlcByInst = {};
    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async (inst) => {
        const allData = [];
        const PAGE = 1000;
        let offset = 0;
        while (true) {
          let q = sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
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
        const parsed = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
        candlesByInst[inst] = parsed;
        const timeToIdx = {};
        for (let i = 0; i < parsed.length; i++) timeToIdx[parsed[i].time] = i;
        ohlcByInst[inst] = { candles: parsed, timeToIdx };
      }
    }

    const indexByInst = {};
    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst] || [];
      const timeToIdx = {};
      for (let i = 0; i < candles.length; i++) {
        timeToIdx[candles[i].time] = i;
      }
      indexByInst[inst] = { candles, timeToIdx };
    }

    const allTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const c of (candlesByInst[inst] || [])) {
        if (c.time >= since && (!until || c.time <= until)) {
          allTimes.add(c.time);
        }
      }
    }
    const timestamps = [...allTimes].sort();

    const timeline = [];
    for (const time of timestamps) {
      const strength = {};
      for (const ccy of CURRENCIES) strength[ccy] = 0;

      let valid = true;
      for (const inst of INSTRUMENTS) {
        const { candles, timeToIdx } = indexByInst[inst];
        const idx = timeToIdx[time];
        if (idx === undefined || idx < LOOKBACK) { valid = false; break; }

        const [base, quote] = inst.split('_');
        const closeNow = candles[idx].close;
        const closePast = candles[idx - LOOKBACK].close;

        const movement = (closeNow - closePast) / closePast;
        strength[base] += movement;
        strength[quote] -= movement;
      }
      if (!valid) continue;

      const ranked = CURRENCIES
        .map(c => ({ currency: c, value: strength[c] }))
        .sort((a, b) => b.value - a.value);

      const chfRank = ranked.findIndex(r => r.currency === 'CHF') + 1;
      const jpyRank = ranked.findIndex(r => r.currency === 'JPY') + 1;
      const chfVal = strength.CHF;
      const jpyVal = strength.JPY;

      let chfSignal = null, jpySignal = null;
      if (chfRank === 1 && chfVal > 0.015) chfSignal = 'STRONGEST';
      else if (chfRank === 8 && chfVal < -0.015) chfSignal = 'WEAKEST';
      if (jpyRank === 1 && jpyVal > 0.015) jpySignal = 'STRONGEST';
      else if (jpyRank === 8 && jpyVal < -0.015) jpySignal = 'WEAKEST';

      timeline.push({
        time,
        ranking: ranked,
        chf: { rank: chfRank, value: chfVal, signal: chfSignal, trades: chfSignal ? bestTrades('CHF', chfSignal, ranked, ohlcByInst, time) : [] },
        jpy: { rank: jpyRank, value: jpyVal, signal: jpySignal, trades: jpySignal ? bestTrades('JPY', jpySignal, ranked, ohlcByInst, time) : [] },
      });
    }

    const chfStrongest = timeline.filter(t => t.chf.signal === 'STRONGEST').length;
    const chfWeakest = timeline.filter(t => t.chf.signal === 'WEAKEST').length;
    const jpyStrongest = timeline.filter(t => t.jpy.signal === 'STRONGEST').length;
    const jpyWeakest = timeline.filter(t => t.jpy.signal === 'WEAKEST').length;

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
      totalBars: timeline.length,
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

module.exports.maxDuration = 60;
