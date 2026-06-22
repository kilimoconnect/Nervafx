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
  if (h >= 23 || h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  if (h >= 13 && h < 21) return 'NEW_YORK';
  return null;
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

  const directionalCandles = mainDir === 'BULLISH' ? bullCandles : bearCandles;
  const smoothnessBase = (directionalCandles / 10) * 100;
  let mainBodySum = 0, oppositeBodySum = 0;
  for (const x of c) {
    const body = Math.abs(x.close - x.open);
    const isBull = x.close > x.open;
    if ((mainDir === 'BULLISH' && isBull) || (mainDir === 'BEARISH' && !isBull)) mainBodySum += body;
    else oppositeBodySum += body;
  }
  const totalBody = mainBodySum + oppositeBodySum;
  const oppositeRatio = totalBody > 0 ? (oppositeBodySum / totalBody) * 100 : 0;
  const smoothness = Math.max(0, smoothnessBase - oppositeRatio);

  const totalWick = c.reduce((s, x) => {
    const body = Math.abs(x.close - x.open);
    return s + (x.high - x.low - body);
  }, 0);
  const wickCleanliness = totalRange > 0 ? 100 - (totalWick / totalRange) * 100 : 0;

  const quality = Math.round(
    0.35 * Math.abs(directionScore) +
    0.30 * impulseStrength +
    0.25 * smoothness +
    0.10 * wickCleanliness
  );

  let classification;
  if (quality >= 80) classification = 'VERY_CLEAN';
  else if (quality >= 65) classification = 'TRADEABLE';
  else if (quality >= 50) classification = 'WEAK';
  else classification = 'CHOPPY';

  const entryValid = Math.abs(directionScore) > 50 && impulseStrength > 50 && smoothness > 65 && wickCleanliness > 55;

  return {
    direction: mainDir,
    directionScore: Math.round(directionScore),
    impulseStrength: Math.round(impulseStrength),
    smoothness: Math.round(smoothness),
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
    const hoursParam = parseInt(req.query?.hours || '168', 10) || 168;

    // For history mode we need 10 extra candles before the window for lookback
    let since;
    if (fromDate) {
      since = new Date(new Date(fromDate).getTime() - 10 * 15 * 60000).toISOString();
    } else {
      since = new Date(Date.now() - hoursParam * 3600000 - 10 * 15 * 60000).toISOString();
    }
    const until = toDate ? new Date(toDate + 'T23:59:59Z').toISOString() : null;

    // Fetch M15 candles for all instruments
    const candlesByInst = {};
    const PAGE = 1000;

    for (const inst of INSTRUMENTS) {
      const allCandles = [];
      let offset = 0;
      while (true) {
        let q = sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst)
          .eq('timeframe', 'M15')
          .eq('complete', true)
          .gte('time', since);
        if (until) q = q.lte('time', until);
        const { data, error } = await q
          .order('time', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (!data?.length) break;
        allCandles.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      candlesByInst[inst] = allCandles.map(c => ({
        time: c.time,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      }));
    }

    // Compute quality at each M15 timestamp (sliding window of 10)
    // Group snapshots by hour for session-level aggregation
    const hourlySnapshots = {};

    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst];
      for (let i = 9; i < candles.length; i++) {
        const window = candles.slice(i - 9, i + 1);
        const q = computeQuality(window);
        if (!q) continue;

        const time = candles[i].time;
        const d = new Date(time);
        const hourKey = d.toISOString().slice(0, 13) + ':00:00Z';

        if (!hourlySnapshots[hourKey]) {
          hourlySnapshots[hourKey] = {
            time: hourKey,
            session: getSession(d.getUTCHours()),
            pairs: {},
          };
        }

        // Keep latest M15 snapshot within each hour per pair
        hourlySnapshots[hourKey].pairs[inst] = q;
      }
    }

    // Build hourly summaries
    const hourlyResults = Object.values(hourlySnapshots)
      .filter(h => h.session)
      .sort((a, b) => a.time.localeCompare(b.time));

    // Build session blocks
    const sessionBlocks = {};
    for (const hr of hourlyResults) {
      const dateStr = hr.time.slice(0, 10);
      const key = `${dateStr}|${hr.session}`;

      if (!sessionBlocks[key]) {
        sessionBlocks[key] = {
          date: dateStr, session: hr.session,
          pairs: {}, hours: 0,
        };
      }
      const block = sessionBlocks[key];
      block.hours++;

      // Aggregate: keep the best quality per pair per session
      for (const [pair, q] of Object.entries(hr.pairs)) {
        if (!block.pairs[pair] || q.quality > block.pairs[pair].quality) {
          block.pairs[pair] = q;
        }
      }
    }

    const sessions = Object.values(sessionBlocks).sort((a, b) => {
      const dc = b.date.localeCompare(a.date);
      if (dc !== 0) return dc;
      const so = { NEW_YORK: 2, LONDON: 1, ASIA: 0 };
      return (so[b.session] || 0) - (so[a.session] || 0);
    });

    // Add summary stats per session
    for (const s of sessions) {
      const pairArr = Object.entries(s.pairs).map(([pair, q]) => ({ pair, ...q }));
      pairArr.sort((a, b) => b.quality - a.quality);
      s.topPairs = pairArr.slice(0, 28);
      s.totalPairs = pairArr.length;

      const veryClean = pairArr.filter(p => p.classification === 'VERY_CLEAN').length;
      const tradeable = pairArr.filter(p => p.classification === 'TRADEABLE').length;
      const entryCount = pairArr.filter(p => p.entryValid).length;
      s.summary = { veryClean, tradeable, entryCount, avgQuality: 0 };
      if (pairArr.length) s.summary.avgQuality = Math.round(pairArr.reduce((s, p) => s + p.quality, 0) / pairArr.length);

      // Currency aggregation
      const ccyQuality = {};
      for (const ccy of CURRENCIES) ccyQuality[ccy] = { totalQ: 0, count: 0, bullish: 0, bearish: 0 };
      for (const p of pairArr) {
        const [base, quote] = p.pair.split('_');
        if (p.direction === 'BULLISH') { ccyQuality[base].bullish++; ccyQuality[quote].bearish++; }
        else if (p.direction === 'BEARISH') { ccyQuality[base].bearish++; ccyQuality[quote].bullish++; }
        ccyQuality[base].totalQ += p.quality; ccyQuality[base].count++;
        ccyQuality[quote].totalQ += p.quality; ccyQuality[quote].count++;
      }
      s.currencies = {};
      for (const ccy of CURRENCIES) {
        const c = ccyQuality[ccy];
        const avg = c.count ? Math.round(c.totalQ / c.count) : 0;
        const net = c.bullish - c.bearish;
        s.currencies[ccy] = {
          avgQuality: avg, bullish: c.bullish, bearish: c.bearish, net,
          direction: net >= 3 ? 'STRONG' : net >= 1 ? 'BULLISH' : net <= -3 ? 'WEAK' : net <= -1 ? 'BEARISH' : 'NEUTRAL',
        };
      }
      delete s.pairs;
    }

    // Latest snapshot (most recent hour)
    const latestHour = hourlyResults.length ? hourlyResults[hourlyResults.length - 1] : null;
    let latest = null;
    if (latestHour) {
      const pairArr = Object.entries(latestHour.pairs).map(([pair, q]) => ({ pair, ...q }));
      pairArr.sort((a, b) => b.quality - a.quality);

      const ccyAgg = {};
      for (const ccy of CURRENCIES) ccyAgg[ccy] = { totalQ: 0, count: 0, bullish: 0, bearish: 0 };
      for (const p of pairArr) {
        const [base, quote] = p.pair.split('_');
        if (p.direction === 'BULLISH') { ccyAgg[base].bullish++; ccyAgg[quote].bearish++; }
        else if (p.direction === 'BEARISH') { ccyAgg[base].bearish++; ccyAgg[quote].bullish++; }
        ccyAgg[base].totalQ += p.quality; ccyAgg[base].count++;
        ccyAgg[quote].totalQ += p.quality; ccyAgg[quote].count++;
      }
      const currencies = {};
      for (const ccy of CURRENCIES) {
        const c = ccyAgg[ccy];
        const avg = c.count ? Math.round(c.totalQ / c.count) : 0;
        const net = c.bullish - c.bearish;
        currencies[ccy] = {
          avgQuality: avg, bullish: c.bullish, bearish: c.bearish, net,
          direction: net >= 3 ? 'STRONG' : net >= 1 ? 'BULLISH' : net <= -3 ? 'WEAK' : net <= -1 ? 'BEARISH' : 'NEUTRAL',
        };
      }

      latest = {
        time: latestHour.time,
        session: latestHour.session,
        pairs: pairArr,
        currencies,
        veryClean: pairArr.filter(p => p.classification === 'VERY_CLEAN').length,
        tradeable: pairArr.filter(p => p.classification === 'TRADEABLE').length,
        entryCount: pairArr.filter(p => p.entryValid).length,
        avgQuality: pairArr.length ? Math.round(pairArr.reduce((s, p) => s + p.quality, 0) / pairArr.length) : 0,
      };
    }

    res.json({
      latest,
      sessions,
      sessionCount: sessions.length,
      totalHours: hourlyResults.length,
    });
  } catch (e) {
    console.error('[M15-QUALITY]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
