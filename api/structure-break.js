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

function getSessionTimezone(session) {
  // Map session to IANA timezone
  if (session === 'ASIA') return 'Asia/Tokyo';
  if (session === 'LONDON') return 'Europe/London';
  if (session === 'NEW_YORK') return 'America/New_York';
  return 'UTC';
}

function getDayInTimezone(isoTime, timezone) {
  // Convert UTC ISO time to date in given timezone
  const d = new Date(isoTime);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: timezone
  });
  return formatter.format(d);
}

function computeH1Quality(candles) {
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

function computeM15Quality(candles) {
  if (candles.length < 10) return null;
  const c = candles.slice(-10);

  const bullCandles = c.filter(x => x.close > x.open).length;
  const bearCandles = c.filter(x => x.close < x.open).length;
  const directionScore = ((bullCandles - bearCandles) / 10) * 100;

  const netMove = Math.abs(c[9].close - c[0].open);
  const totalRange = c.reduce((s, x) => s + (x.high - x.low), 0);
  const impulseStrength = totalRange > 0 ? (netMove / totalRange) * 100 : 0;

  const totalWick = c.reduce((s, x) => {
    const body = Math.abs(x.close - x.open);
    return s + (x.high - x.low - body);
  }, 0);
  const wickCleanliness = totalRange > 0 ? 100 - (totalWick / totalRange) * 100 : 0;

  return Math.round(
    0.15 * Math.abs(directionScore) +
    0.80 * impulseStrength +
    0.05 * wickCleanliness
  );
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
    const hoursParam = Math.min(8760, parseInt(req.query?.hours || '168', 10) || 168);

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

    // Fetch M15 candles in parallel
    const m15ByInst = {};
    const m15Since = new Date(new Date(since).getTime() - 10 * 15 * 60000).toISOString();
    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async (inst) => {
        let q = sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst)
          .eq('timeframe', 'M15')
          .eq('complete', true)
          .gte('time', m15Since);
        if (until) q = q.lte('time', until);
        const { data, error } = await q
          .order('time', { ascending: true })
          .limit(5000);
        if (error) throw error;
        return { inst, data: data || [] };
      }));
      for (const { inst, data } of results) {
        m15ByInst[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    // Fetch energy data from hourly_session_activity
    const energyMap = {};
    {
      const allRows = [];
      const PAGE = 1000;
      let pgOffset = 0;
      while (true) {
        let q = sb
          .from('hourly_session_activity')
          .select('time_utc, market_energy, dispersion_score, tradability_score, movement_score, breadth_score, agreement_score')
          .gte('time_utc', since);
        if (until) q = q.lte('time_utc', until);
        const { data, error } = await q
          .order('time_utc', { ascending: true })
          .range(pgOffset, pgOffset + PAGE - 1);
        if (error) throw error;
        if (!data || !data.length) break;
        allRows.push(...data);
        if (data.length < PAGE) break;
        pgOffset += PAGE;
      }
      for (const row of allRows) {
        energyMap[row.time_utc] = {
          energy: row.market_energy,
          dispersion: row.dispersion_score,
          tradability: row.tradability_score,
          movement: row.movement_score,
          breadth: row.breadth_score,
          agreement: row.agreement_score,
        };
      }
    }

    const h1Snapshots = {};
    const qualityMap = {};
    const breakMap = {};
    const m15QualityMap = {};
    const dayHighLow = {}; // dayHighLow[inst][tz][dayStr] = { high, low }

    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst];
      const m15Candles = m15ByInst[inst] || [];
      const tzDayTracking = {}; // tzDayTracking[tz][dayStr] = { high, low }

      for (let i = 5; i < candles.length; i++) {
        const q = computeH1Quality(candles.slice(i - 5, i + 1));
        if (!q) continue;

        const time = candles[i].time;

        // Track day high/low for each timezone
        for (const session of ['ASIA', 'LONDON', 'NEW_YORK']) {
          const tz = getSessionTimezone(session);
          const dayStr = getDayInTimezone(time, tz);

          if (!tzDayTracking[tz]) tzDayTracking[tz] = {};
          if (!tzDayTracking[tz][dayStr]) tzDayTracking[tz][dayStr] = { high: -Infinity, low: Infinity };

          tzDayTracking[tz][dayStr].high = Math.max(tzDayTracking[tz][dayStr].high, candles[i].high);
          tzDayTracking[tz][dayStr].low = Math.min(tzDayTracking[tz][dayStr].low, candles[i].low);
        }
        dayHighLow[inst] = tzDayTracking;

        if (!h1Snapshots[time]) {
          const d = new Date(time);
          h1Snapshots[time] = { time, session: getSession(d.getUTCHours()), pairs: {} };
          qualityMap[time] = {};
          breakMap[time] = {};
          m15QualityMap[time] = {};
        }
        h1Snapshots[time].pairs[inst] = q;
        qualityMap[time][inst] = q.quality;

        // Structure break: close above previous high (bullish) or below previous low (bearish)
        const curr = candles[i];
        const prev = candles[i - 1];
        if (q.direction === 'BULLISH' && curr.close > prev.high) {
          breakMap[time][inst] = true;
        } else if (q.direction === 'BEARISH' && curr.close < prev.low) {
          breakMap[time][inst] = true;
        }

        // M15 quality: find latest 10 M15 candles at or before this H1 time
        const cutoff = new Date(time).getTime();
        let endIdx = -1;
        for (let j = m15Candles.length - 1; j >= 0; j--) {
          if (new Date(m15Candles[j].time).getTime() <= cutoff) { endIdx = j; break; }
        }
        if (endIdx >= 9) {
          const m15q = computeM15Quality(m15Candles.slice(endIdx - 9, endIdx + 1));
          if (m15q !== null) m15QualityMap[time][inst] = m15q;
        }
      }
    }

    const sortedSnaps = Object.values(h1Snapshots)
      .filter(s => s.session)
      .sort((a, b) => b.time.localeCompare(a.time));

    const top5ByTime = {};
    for (const snap of sortedSnaps) {
      const breaks = breakMap[snap.time] || {};
      const m15q = m15QualityMap[snap.time] || {};
      const sorted = Object.entries(snap.pairs)
        .map(([pair, q]) => ({ pair, quality: q.quality, brk: !!breaks[pair], m15: m15q[pair] || 0 }))
        .sort((a, b) => {
          if (a.brk !== b.brk) return a.brk ? -1 : 1;
          if (a.m15 !== b.m15) return b.m15 - a.m15;
          return b.quality - a.quality;
        })
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
        if (set1.has(pair) && qs0[pair] > 40) {
          trending.push(pair);
        }
      }
      if (trending.length) trendingSets[t0] = trending;
    }

    const timeline = sortedSnaps.map(snap => {
      const trending = new Set(trendingSets[snap.time] || []);
      const breaks = breakMap[snap.time] || {};
      const m15q = m15QualityMap[snap.time] || {};
      const tz = getSessionTimezone(snap.session);
      const dayStr = getDayInTimezone(snap.time, tz);
      const pairArr = Object.entries(snap.pairs)
        .map(([pair, q]) => {
          // Only check the LATEST candle (at snap.time) for day high/low
          const candle = candlesByInst[pair]?.find(c => c.time === snap.time);
          const isLatestCandle = candle && candle.time === snap.time;
          const tzDayTracking = dayHighLow[pair] || {};
          const dayData = tzDayTracking[tz]?.[dayStr] || { high: -Infinity, low: Infinity };
          const isDayHigh = isLatestCandle && candle.high === dayData.high;
          const isDayLow = isLatestCandle && candle.low === dayData.low;
          return {
            pair, ...q, trending: trending.has(pair), structureBreak: !!breaks[pair],
            m15Quality: m15q[pair] || 0, dayHigh: isDayHigh, dayLow: isDayLow
          };
        })
        .sort((a, b) => {
          if (a.structureBreak !== b.structureBreak) return a.structureBreak ? -1 : 1;
          if (a.m15Quality !== b.m15Quality) return b.m15Quality - a.m15Quality;
          return b.quality - a.quality;
        });

      const en = energyMap[snap.time] || {};
      return {
        time: snap.time,
        session: snap.session,
        top5: pairArr.slice(0, 5),
        trendingCount: trending.size,
        totalPairs: pairArr.length,
        avgQuality: pairArr.length ? Math.round(pairArr.reduce((s, p) => s + p.quality, 0) / pairArr.length) : 0,
        entryCount: pairArr.filter(p => p.entryValid).length,
        veryClean: pairArr.filter(p => p.classification === 'VERY_CLEAN').length,
        energy: en.energy ?? null,
        dispersion: en.dispersion ?? null,
        tradability: en.tradability ?? null,
        movement: en.movement ?? null,
        breadth: en.breadth ?? null,
        agreement: en.agreement ?? null,
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
