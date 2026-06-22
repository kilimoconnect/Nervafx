'use strict';

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

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

function getSession(h) {
  if (h >= 23 || h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  if (h >= 13 && h < 21) return 'NEW_YORK';
  return null;
}

function computeQuality(candles) {
  if (candles.length < 6) return null;
  const c = candles.slice(-6);

  const bullCandles = c.filter(x => x.close > x.open).length;
  const bearCandles = c.filter(x => x.close < x.open).length;
  const directionScore = ((bullCandles - bearCandles) / 6) * 100;
  const mainDir = directionScore > 0 ? 'BULLISH' : directionScore < 0 ? 'BEARISH' : 'NEUTRAL';

  const netMove = Math.abs(c[5].close - c[0].open);
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

  let classification;
  if (quality >= 60) classification = 'VERY_CLEAN';
  else if (quality >= 45) classification = 'TRADEABLE';
  else if (quality >= 30) classification = 'WEAK';
  else classification = 'CHOPPY';

  const entryValid = Math.abs(directionScore) > 40 && impulseStrength > 40 && wickCleanliness > 45;

  return {
    direction: mainDir,
    directionScore: Math.round(directionScore),
    impulseStrength: Math.round(impulseStrength),
    wickCleanliness: Math.round(wickCleanliness),
    quality, classification, entryValid,
    bullCandles, bearCandles,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    const gate = await requirePlan(sb, req, 'premium');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const fromDate = req.query?.from || null;
    const toDate = req.query?.to || null;
    const hoursParam = Math.min(2000, parseInt(req.query?.hours || '168', 10) || 168);

    let since;
    if (fromDate) {
      since = new Date(new Date(fromDate).getTime() - 6 * 3600000).toISOString();
    } else {
      since = new Date(Date.now() - hoursParam * 3600000 - 6 * 3600000).toISOString();
    }
    const until = toDate ? new Date(toDate + 'T23:59:59Z').toISOString() : null;

    const candlesByInst = {};

    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async (inst) => {
        let q = sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst)
          .eq('timeframe', 'H1')
          .eq('complete', true)
          .gte('time', since);
        if (until) q = q.lte('time', until);
        const { data, error } = await q
          .order('time', { ascending: true })
          .limit(2000);
        if (error) throw error;
        return { inst, data: data || [] };
      }));
      for (const { inst, data } of results) {
        candlesByInst[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    const h1Snapshots = {};
    const qualityMap = {};

    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst];
      for (let i = 5; i < candles.length; i++) {
        const q = computeQuality(candles.slice(i - 5, i + 1));
        if (!q) continue;

        const time = candles[i].time;
        if (!h1Snapshots[time]) {
          const d = new Date(time);
          h1Snapshots[time] = { time, session: getSession(d.getUTCHours()), pairs: {} };
          qualityMap[time] = {};
        }
        h1Snapshots[time].pairs[inst] = q;
        qualityMap[time][inst] = q.quality;
      }
    }

    const sortedSnaps = Object.values(h1Snapshots)
      .filter(s => s.session)
      .sort((a, b) => b.time.localeCompare(a.time));

    const top5ByTime = {};
    for (const snap of sortedSnaps) {
      const sorted = Object.entries(snap.pairs)
        .map(([pair, q]) => ({ pair, quality: q.quality }))
        .sort((a, b) => b.quality - a.quality)
        .slice(0, 5);
      top5ByTime[snap.time] = new Set(sorted.map(p => p.pair));
    }

    const trendingSets = {};
    for (let si = 0; si < sortedSnaps.length - 1; si++) {
      const t0 = sortedSnaps[si].time;
      const t1 = sortedSnaps[si + 1].time;
      const set0 = top5ByTime[t0] || new Set();
      const set1 = top5ByTime[t1] || new Set();
      const qs0 = qualityMap[t0] || {};
      const trending = [];
      for (const pair of set0) {
        if (set1.has(pair) && qs0[pair] >= 20) {
          trending.push(pair);
        }
      }
      if (trending.length) trendingSets[t0] = trending;
    }

    const timeline = sortedSnaps.map(snap => {
      const trending = new Set(trendingSets[snap.time] || []);
      const pairArr = Object.entries(snap.pairs)
        .map(([pair, q]) => ({ pair, ...q, trending: trending.has(pair) }))
        .sort((a, b) => {
          if (a.trending !== b.trending) return a.trending ? -1 : 1;
          return b.quality - a.quality;
        });

      return {
        time: snap.time,
        session: snap.session,
        top5: pairArr.slice(0, 5),
        trendingCount: trending.size,
        totalPairs: pairArr.length,
        avgQuality: pairArr.length ? Math.round(pairArr.reduce((s, p) => s + p.quality, 0) / pairArr.length) : 0,
        entryCount: pairArr.filter(p => p.entryValid).length,
        veryClean: pairArr.filter(p => p.classification === 'VERY_CLEAN').length,
      };
    });

    res.json({
      timeline,
      snapshotCount: timeline.length,
    });
  } catch (e) {
    console.error('[STRUCTURE-BREAK]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
