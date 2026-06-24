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

function getSession(h) {
  // Cover all 24 hours so no snapshot is dropped (21:00-22:59 = Asia/Sydney open)
  if (h >= 21 || h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  return 'NEW_YORK'; // 13:00-20:59
}

function getSessionTimezone(session) {
  if (session === 'ASIA') return 'Asia/Tokyo';
  if (session === 'LONDON') return 'Europe/London';
  if (session === 'NEW_YORK') return 'America/New_York';
  return 'UTC';
}

function getDayInTimezone(isoTime, timezone) {
  const d = new Date(isoTime);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: timezone
  });
  return formatter.format(d);
}

function computeQuality(candles) {
  if (candles.length < 10) return null;
  const c = candles.slice(-10);

  const bullCandles = c.filter(x => x.close > x.open).length;
  const bearCandles = c.filter(x => x.close < x.open).length;
  const directionScore = ((bullCandles - bearCandles) / 10) * 100;
  const mainDir = directionScore > 0 ? 'BULLISH' : directionScore < 0 ? 'BEARISH' : 'NEUTRAL';

  const netMove = Math.abs(c[9].close - c[0].open);
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
  if (quality >= 80) classification = 'VERY_CLEAN';
  else if (quality >= 65) classification = 'TRADEABLE';
  else if (quality >= 40) classification = 'WEAK';
  else classification = 'CHOPPY';

  const entryValid = Math.abs(directionScore) > 50 && impulseStrength > 50 && wickCleanliness > 55;

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
    const hoursParam = Math.min(8760, parseInt(req.query?.hours || '24', 10) || 24);

    let since;
    if (fromDate) {
      since = new Date(new Date(fromDate).getTime() - 10 * 15 * 60000).toISOString();
    } else {
      since = new Date(Date.now() - hoursParam * 3600000 - 10 * 15 * 60000).toISOString();
    }
    const until = toDate ? new Date(toDate + 'T23:59:59Z').toISOString() : null;

    // For day high/low calculation, also fetch from start of UTC day
    const dayStartUTC = new Date(new Date().toISOString().split('T')[0] + 'T00:00:00Z');
    const sinceForDayHL = dayStartUTC.toISOString();
    const sinceToUse = new Date(Math.min(new Date(since).getTime(), new Date(sinceForDayHL).getTime())).toISOString();

    // Estimate span in hours for fetch limit calculation
    const spanHours = fromDate
      ? Math.ceil((new Date(until || Date.now()) - new Date(since)) / 3600000)
      : hoursParam;

    const candlesByInst = {};

    // Fetch all instruments in parallel (batches of 7 to avoid connection limits)
    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async (inst) => {
        let q = sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst)
          .eq('timeframe', 'M15')
          .eq('complete', true)
          .gte('time', sinceToUse);
        if (until) q = q.lte('time', until);
        const fetchLimit = Math.min(10000, spanHours * 4 + 20);
        const { data, error } = await q
          .order('time', { ascending: true })
          .limit(fetchLimit);
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

    // Compute quality at each M15 timestamp per pair
    // qualityMap[time][instrument] = quality score (number)
    const m15Snapshots = {};
    const qualityMap = {};
    // newExtreme[inst][time][tz] = { newHigh, newLow } — did this candle create a
    // new running high/low of the day (in that timezone) at that moment?
    const newExtreme = {};
    const SESSIONS_TZ = ['ASIA', 'LONDON', 'NEW_YORK'].map(getSessionTimezone);

    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst];
      newExtreme[inst] = {};
      const running = {}; // running[tz] = { dayStr, high, low }

      // Walk ALL candles chronologically to track running day extremes
      for (let i = 0; i < candles.length; i++) {
        const time = candles[i].time;
        newExtreme[inst][time] = {};
        for (const tz of SESSIONS_TZ) {
          const dayStr = getDayInTimezone(time, tz);
          if (!running[tz] || running[tz].dayStr !== dayStr) {
            running[tz] = { dayStr, high: -Infinity, low: Infinity };
          }
          const isNewHigh = candles[i].high > running[tz].high;
          const isNewLow = candles[i].low < running[tz].low;
          running[tz].high = Math.max(running[tz].high, candles[i].high);
          running[tz].low = Math.min(running[tz].low, candles[i].low);
          newExtreme[inst][time][tz] = { newHigh: isNewHigh, newLow: isNewLow };
        }
      }

      for (let i = 9; i < candles.length; i++) {
        const q = computeQuality(candles.slice(i - 9, i + 1));
        if (!q) continue;

        const time = candles[i].time;
        if (!m15Snapshots[time]) {
          const d = new Date(time);
          m15Snapshots[time] = { time, session: getSession(d.getUTCHours()), pairs: {} };
          qualityMap[time] = {};
        }
        m15Snapshots[time].pairs[inst] = q;
        qualityMap[time][inst] = q.quality;
      }
    }

    // Build sorted timeline (newest first)
    const sortedSnaps = Object.values(m15Snapshots)
      .filter(s => s.session)
      .sort((a, b) => b.time.localeCompare(a.time));

    // First pass: compute top 5 by quality for each snapshot
    const top5ByTime = {};
    for (const snap of sortedSnaps) {
      const sorted = Object.entries(snap.pairs)
        .map(([pair, q]) => ({ pair, quality: q.quality }))
        .sort((a, b) => b.quality - a.quality)
        .slice(0, 5);
      top5ByTime[snap.time] = new Set(sorted.map(p => p.pair));
    }

    // Trending: pairs with entryValid=true (D>50, I>50, W>55)
    const trendingSets = {};
    for (const snap of sortedSnaps) {
      const trending = Object.entries(snap.pairs)
        .filter(([pair, q]) => q.entryValid)
        .map(([pair]) => pair);
      if (trending.length) {
        trendingSets[snap.time] = trending;
      }
    }

    const timeline = sortedSnaps.map(snap => {
      const trending = new Set(trendingSets[snap.time] || []);
      const tz = getSessionTimezone(snap.session);
      const pairArr = Object.entries(snap.pairs)
        .map(([pair, q]) => {
          // Did this candle create a new running high/low of the day at this moment?
          const ext = newExtreme[pair]?.[snap.time]?.[tz] || {};
          return { pair, ...q, trending: trending.has(pair), dayHigh: !!ext.newHigh, dayLow: !!ext.newLow };
        })
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
    console.error('[M15-QUALITY]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
