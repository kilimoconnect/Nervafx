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

const LOOKBACK = 10; // 10 M15 candles for strength
const Q_CANDLES = 10; // 10 M15 candles for quality

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
  const others = ranked.filter(r => r.currency !== ccy && r.currency !== (ccy === 'AUD' ? 'NZD' : 'AUD'));
  const targets = signal === 'STRONGEST' ? others.slice(-3).reverse() : others.slice(0, 3);
  return targets.map(t => {
    const pair = PAIR_MAP[ccy][t.currency];
    const isBase = BASE_OF[pair] === ccy;
    const direction = signal === 'STRONGEST'
      ? (isBase ? 'BUY' : 'SELL')
      : (isBase ? 'SELL' : 'BUY');

    // Compute M15 quality for this pair
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

    // Fetch extra candles for the lookback window
    const fetchSince = new Date(new Date(since).getTime() - LOOKBACK * 15 * 60 * 1000).toISOString();

    // Fetch M15 candles with OHLC for all 28 instruments
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

    // Build per-instrument index for strength (close only)
    const indexByInst = {};
    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst] || [];
      const timeToIdx = {};
      for (let i = 0; i < candles.length; i++) {
        timeToIdx[candles[i].time] = i;
      }
      indexByInst[inst] = { candles, timeToIdx };
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

    // Compute strength at each M15 timestamp using 10-candle lookback by index
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

      const audRank = ranked.findIndex(r => r.currency === 'AUD') + 1;
      const nzdRank = ranked.findIndex(r => r.currency === 'NZD') + 1;
      const audVal = strength.AUD;
      const nzdVal = strength.NZD;

      let audSignal = null, nzdSignal = null;
      if (audRank === 1 && audVal > 0.012) audSignal = 'STRONGEST';
      else if (audRank === 8 && audVal < -0.012) audSignal = 'WEAKEST';
      if (nzdRank === 1 && nzdVal > 0.012) nzdSignal = 'STRONGEST';
      else if (nzdRank === 8 && nzdVal < -0.012) nzdSignal = 'WEAKEST';

      timeline.push({
        time,
        ranking: ranked,
        aud: { rank: audRank, value: audVal, signal: audSignal, trades: audSignal ? bestTrades('AUD', audSignal, ranked, ohlcByInst, time) : [] },
        nzd: { rank: nzdRank, value: nzdVal, signal: nzdSignal, trades: nzdSignal ? bestTrades('NZD', nzdSignal, ranked, ohlcByInst, time) : [] },
      });
    }

    // Summary
    const audStrongest = timeline.filter(t => t.aud.signal === 'STRONGEST').length;
    const audWeakest = timeline.filter(t => t.aud.signal === 'WEAKEST').length;
    const nzdStrongest = timeline.filter(t => t.nzd.signal === 'STRONGEST').length;
    const nzdWeakest = timeline.filter(t => t.nzd.signal === 'WEAKEST').length;

    // Signal events — AUD and NZD must move in the same direction
    const signals = timeline.filter(t => {
      if (!t.aud.signal && !t.nzd.signal) return false;
      if (t.aud.signal && t.nzd.signal && t.aud.signal !== t.nzd.signal) return false;
      // If AUD weak, NZD must also be weak half (rank 5-8)
      if (t.aud.signal === 'WEAKEST' && t.nzd.rank <= 4) return false;
      // If AUD strong, NZD must also be strong half (rank 1-4)
      if (t.aud.signal === 'STRONGEST' && t.nzd.rank >= 5) return false;
      // If NZD weak, AUD must also be weak half
      if (t.nzd.signal === 'WEAKEST' && t.aud.rank <= 4) return false;
      // If NZD strong, AUD must also be strong half
      if (t.nzd.signal === 'STRONGEST' && t.aud.rank >= 5) return false;
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
