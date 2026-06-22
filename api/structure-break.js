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
    let since;
    if (fromDate) {
      since = new Date(fromDate).toISOString();
    } else {
      const hours = Math.min(10000, parseInt(req.query?.hours || '168', 10) || 168);
      since = new Date(Date.now() - hours * 3600000).toISOString();
    }
    const until = toDate ? new Date(toDate + 'T23:59:59Z').toISOString() : null;

    // Fetch H1 candles for all instruments
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
          .eq('timeframe', 'H1')
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

    // Detect structure breaks per pair per hour
    const pairBreaks = {};  // { inst: [{ time, type, close, prevHigh, prevLow, magnitude }] }

    for (const inst of INSTRUMENTS) {
      const candles = candlesByInst[inst];
      pairBreaks[inst] = [];

      for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];
        const session = getSession(new Date(curr.time).getUTCHours());
        if (!session) continue;

        let breakType = null;
        let magnitude = 0;

        if (curr.close > prev.high) {
          breakType = 'BULLISH';
          magnitude = Math.round((curr.close - prev.high) * 100000) / 10;
        } else if (curr.close < prev.low) {
          breakType = 'BEARISH';
          magnitude = Math.round((prev.low - curr.close) * 100000) / 10;
        }

        if (breakType) {
          // Check for strong break: close beyond prev high/low by significant margin
          // AND body > 50% of candle range (conviction)
          const body = Math.abs(curr.close - curr.open);
          const range = curr.high - curr.low;
          const bodyRatio = range > 0 ? body / range : 0;
          const isStrong = magnitude >= 3.0 && bodyRatio >= 0.5;

          // Multi-candle context: count consecutive breaks in same direction
          let streak = 1;
          for (let j = pairBreaks[inst].length - 1; j >= 0; j--) {
            if (pairBreaks[inst][j].type === breakType) streak++;
            else break;
          }

          pairBreaks[inst].push({
            time: curr.time,
            session,
            type: breakType,
            close: curr.close,
            prevHigh: prev.high,
            prevLow: prev.low,
            magnitude,
            bodyRatio: Math.round(bodyRatio * 100),
            strong: isStrong,
            streak,
          });
        }
      }
    }

    // Aggregate to currency level per hour
    const allBreakTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const b of pairBreaks[inst]) allBreakTimes.add(b.time);
    }
    const sortedTimes = [...allBreakTimes].sort();

    // Per-hour currency break scores
    const hourlyScores = [];
    for (const time of sortedTimes) {
      const session = getSession(new Date(time).getUTCHours());
      const ccyBullish = {};
      const ccyBearish = {};
      const ccyStrong = {};
      const breakDetails = [];

      for (const ccy of CURRENCIES) {
        ccyBullish[ccy] = 0;
        ccyBearish[ccy] = 0;
        ccyStrong[ccy] = 0;
      }

      for (const inst of INSTRUMENTS) {
        const brk = pairBreaks[inst].find(b => b.time === time);
        if (!brk) continue;

        const [base, quote] = inst.split('_');

        if (brk.type === 'BULLISH') {
          ccyBullish[base]++;
          ccyBearish[quote]++;
          if (brk.strong) { ccyStrong[base]++; ccyStrong[quote]++; }
        } else {
          ccyBearish[base]++;
          ccyBullish[quote]++;
          if (brk.strong) { ccyStrong[base]++; ccyStrong[quote]++; }
        }

        breakDetails.push({
          pair: inst,
          type: brk.type,
          magnitude: brk.magnitude,
          bodyRatio: brk.bodyRatio,
          strong: brk.strong,
          streak: brk.streak,
        });
      }

      // Currency scores: net breaks (bullish - bearish) out of 7 pairs
      const ccyScores = {};
      for (const ccy of CURRENCIES) {
        const net = ccyBullish[ccy] - ccyBearish[ccy];
        const total = ccyBullish[ccy] + ccyBearish[ccy];
        const strongCount = ccyStrong[ccy];
        ccyScores[ccy] = {
          bullish: ccyBullish[ccy],
          bearish: ccyBearish[ccy],
          net,
          total,
          strong: strongCount,
          direction: net > 0 ? 'STRONG' : net < 0 ? 'WEAK' : 'NEUTRAL',
          score: Math.round((net / 7) * 100),
        };
      }

      hourlyScores.push({
        time,
        session,
        currencies: ccyScores,
        pairs: breakDetails,
        totalBreaks: breakDetails.length,
      });
    }

    // Build session summaries: aggregate breaks within each session block
    const sessionBlocks = {};
    for (const hs of hourlyScores) {
      const d = new Date(hs.time);
      const dateStr = d.toISOString().slice(0, 10);
      const blockKey = `${dateStr}|${hs.session}`;

      if (!sessionBlocks[blockKey]) {
        sessionBlocks[blockKey] = {
          date: dateStr, session: hs.session,
          currencies: {},
          pairBreaks: {},
          hours: 0,
        };
        for (const ccy of CURRENCIES) {
          sessionBlocks[blockKey].currencies[ccy] = { bullish: 0, bearish: 0, strong: 0 };
        }
      }

      const block = sessionBlocks[blockKey];
      block.hours++;

      for (const ccy of CURRENCIES) {
        block.currencies[ccy].bullish += hs.currencies[ccy].bullish;
        block.currencies[ccy].bearish += hs.currencies[ccy].bearish;
        block.currencies[ccy].strong += hs.currencies[ccy].strong;
      }

      for (const pb of hs.pairs) {
        if (!block.pairBreaks[pb.pair]) {
          block.pairBreaks[pb.pair] = { bullish: 0, bearish: 0, strong: 0, maxMag: 0, maxStreak: 0 };
        }
        const p = block.pairBreaks[pb.pair];
        if (pb.type === 'BULLISH') p.bullish++;
        else p.bearish++;
        if (pb.strong) p.strong++;
        p.maxMag = Math.max(p.maxMag, pb.magnitude);
        p.maxStreak = Math.max(p.maxStreak, pb.streak);
      }
    }

    // Build final session summaries
    const sessions = Object.values(sessionBlocks).map(block => {
      const ccySummary = {};
      for (const ccy of CURRENCIES) {
        const c = block.currencies[ccy];
        const net = c.bullish - c.bearish;
        ccySummary[ccy] = {
          ...c,
          net,
          direction: net >= 3 ? 'STRONG' : net >= 1 ? 'BULLISH' : net <= -3 ? 'WEAK' : net <= -1 ? 'BEARISH' : 'NEUTRAL',
          score: Math.round((net / (c.bullish + c.bearish || 1)) * 100),
        };
      }

      // Top movers
      const sorted = Object.entries(ccySummary).sort((a, b) => b[1].net - a[1].net);
      const strongest = sorted[0];
      const weakest = sorted[sorted.length - 1];

      // Top pair breaks
      const topPairs = Object.entries(block.pairBreaks)
        .map(([pair, d]) => ({
          pair,
          net: d.bullish - d.bearish,
          bullish: d.bullish,
          bearish: d.bearish,
          strong: d.strong,
          maxMag: d.maxMag,
          maxStreak: d.maxStreak,
        }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

      return {
        date: block.date,
        session: block.session,
        hours: block.hours,
        currencies: ccySummary,
        strongest: { currency: strongest[0], ...strongest[1] },
        weakest: { currency: weakest[0], ...weakest[1] },
        topPairs: topPairs.slice(0, 10),
        totalBreaks: topPairs.reduce((s, p) => s + p.bullish + p.bearish, 0),
      };
    });

    sessions.sort((a, b) => {
      const dc = b.date.localeCompare(a.date);
      if (dc !== 0) return dc;
      const so = { NEW_YORK: 2, LONDON: 1, ASIA: 0 };
      return (so[b.session] || 0) - (so[a.session] || 0);
    });

    // Latest snapshot: most recent hour's currency state
    const latest = hourlyScores.length ? hourlyScores[hourlyScores.length - 1] : null;

    // Currency momentum: trend of last N hours per currency
    const momentum = {};
    const recentHours = hourlyScores.slice(-6);
    for (const ccy of CURRENCIES) {
      const nets = recentHours.map(h => h.currencies[ccy].net);
      const avg = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0;
      const trend = nets.length >= 3 ?
        (nets[nets.length - 1] > nets[0] ? 'RISING' : nets[nets.length - 1] < nets[0] ? 'FALLING' : 'FLAT') : 'FLAT';
      momentum[ccy] = {
        avg: Math.round(avg * 10) / 10,
        trend,
        last6h: nets,
        direction: avg > 0.5 ? 'BULLISH' : avg < -0.5 ? 'BEARISH' : 'NEUTRAL',
      };
    }

    res.json({
      latest,
      momentum,
      sessions,
      sessionCount: sessions.length,
      totalHours: hourlyScores.length,
    });
  } catch (e) {
    console.error('[STRUCTURE-BREAK]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
