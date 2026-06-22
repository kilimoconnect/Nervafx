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

    // Detect structure breaks per pair per hour at 3 lookback depths
    const LOOKBACKS = [1, 3, 6]; // H1, H3, H6
    const pairBreaksByLB = {}; // { lb: { inst: [breaks] } }

    for (const lb of LOOKBACKS) {
      pairBreaksByLB[lb] = {};
      for (const inst of INSTRUMENTS) {
        const candles = candlesByInst[inst];
        const breaks = [];

        for (let i = lb; i < candles.length; i++) {
          const curr = candles[i];
          const session = getSession(new Date(curr.time).getUTCHours());
          if (!session) continue;

          // Find highest high and lowest low of previous `lb` candles
          let prevHigh = -Infinity, prevLow = Infinity;
          for (let j = i - lb; j < i; j++) {
            prevHigh = Math.max(prevHigh, candles[j].high);
            prevLow = Math.min(prevLow, candles[j].low);
          }

          let breakType = null, magnitude = 0;
          if (curr.close > prevHigh) {
            breakType = 'BULLISH';
            magnitude = Math.round((curr.close - prevHigh) * 100000) / 10;
          } else if (curr.close < prevLow) {
            breakType = 'BEARISH';
            magnitude = Math.round((prevLow - curr.close) * 100000) / 10;
          }

          if (breakType) {
            const body = Math.abs(curr.close - curr.open);
            const range = curr.high - curr.low;
            const bodyRatio = range > 0 ? body / range : 0;
            const isStrong = magnitude >= 3.0 && bodyRatio >= 0.5;

            breaks.push({
              time: curr.time, session, type: breakType,
              magnitude, bodyRatio: Math.round(bodyRatio * 100), strong: isStrong,
            });
          }
        }
        pairBreaksByLB[lb][inst] = breaks;
      }
    }

    // Collect all timestamps where any break occurred at any lookback
    const allBreakTimes = new Set();
    for (const lb of LOOKBACKS) {
      for (const inst of INSTRUMENTS) {
        for (const b of pairBreaksByLB[lb][inst]) allBreakTimes.add(b.time);
      }
    }
    const sortedTimes = [...allBreakTimes].sort();

    // Per-hour currency break scores — with H1/H3/H6 layers
    const hourlyScores = [];
    for (const time of sortedTimes) {
      const session = getSession(new Date(time).getUTCHours());

      const byLB = {};
      for (const lb of LOOKBACKS) {
        const ccyBull = {}, ccyBear = {}, ccyStr = {};
        for (const ccy of CURRENCIES) { ccyBull[ccy] = 0; ccyBear[ccy] = 0; ccyStr[ccy] = 0; }
        const details = [];

        for (const inst of INSTRUMENTS) {
          const brk = pairBreaksByLB[lb][inst].find(b => b.time === time);
          if (!brk) continue;
          const [base, quote] = inst.split('_');
          if (brk.type === 'BULLISH') { ccyBull[base]++; ccyBear[quote]++; }
          else { ccyBear[base]++; ccyBull[quote]++; }
          if (brk.strong) { ccyStr[base]++; ccyStr[quote]++; }
          details.push({ pair: inst, type: brk.type, magnitude: brk.magnitude, bodyRatio: brk.bodyRatio, strong: brk.strong });
        }

        const ccyScores = {};
        for (const ccy of CURRENCIES) {
          const net = ccyBull[ccy] - ccyBear[ccy];
          ccyScores[ccy] = {
            bullish: ccyBull[ccy], bearish: ccyBear[ccy], net,
            total: ccyBull[ccy] + ccyBear[ccy], strong: ccyStr[ccy],
            direction: net > 0 ? 'STRONG' : net < 0 ? 'WEAK' : 'NEUTRAL',
          };
        }
        byLB[lb] = { currencies: ccyScores, pairs: details, totalBreaks: details.length };
      }

      // Primary view uses H1 for backward compat, but includes all layers
      hourlyScores.push({
        time, session,
        currencies: byLB[1].currencies,
        pairs: byLB[1].pairs,
        totalBreaks: byLB[1].totalBreaks,
        h3: byLB[3],
        h6: byLB[6],
      });
    }

    // Build session summaries: aggregate breaks within each session block
    // Tracks H1, H3, H6 layers per session block
    const sessionBlocks = {};
    const LB_KEYS = { 1: 'h1', 3: 'h3', 6: 'h6' };

    for (const hs of hourlyScores) {
      const d = new Date(hs.time);
      const dateStr = d.toISOString().slice(0, 10);
      const blockKey = `${dateStr}|${hs.session}`;

      if (!sessionBlocks[blockKey]) {
        const initLB = () => {
          const o = { currencies: {}, pairBreaks: {} };
          for (const ccy of CURRENCIES) o.currencies[ccy] = { bullish: 0, bearish: 0, strong: 0 };
          return o;
        };
        sessionBlocks[blockKey] = {
          date: dateStr, session: hs.session, hours: 0,
          h1: initLB(), h3: initLB(), h6: initLB(),
        };
      }

      const block = sessionBlocks[blockKey];
      block.hours++;

      // Aggregate each lookback layer
      for (const [lbStr, lbKey] of Object.entries(LB_KEYS)) {
        const src = lbKey === 'h1' ? hs : hs[lbKey];
        if (!src) continue;
        const layer = block[lbKey];

        for (const ccy of CURRENCIES) {
          if (src.currencies[ccy]) {
            layer.currencies[ccy].bullish += src.currencies[ccy].bullish;
            layer.currencies[ccy].bearish += src.currencies[ccy].bearish;
            layer.currencies[ccy].strong += src.currencies[ccy].strong;
          }
        }

        for (const pb of (src.pairs || [])) {
          if (!layer.pairBreaks[pb.pair]) {
            layer.pairBreaks[pb.pair] = { bullish: 0, bearish: 0, strong: 0, maxMag: 0 };
          }
          const p = layer.pairBreaks[pb.pair];
          if (pb.type === 'BULLISH') p.bullish++;
          else p.bearish++;
          if (pb.strong) p.strong++;
          p.maxMag = Math.max(p.maxMag, pb.magnitude);
        }
      }
    }

    function buildSessionSummary(layerData) {
      const ccySummary = {};
      for (const ccy of CURRENCIES) {
        const c = layerData.currencies[ccy];
        const net = c.bullish - c.bearish;
        ccySummary[ccy] = {
          ...c, net,
          direction: net >= 3 ? 'STRONG' : net >= 1 ? 'BULLISH' : net <= -3 ? 'WEAK' : net <= -1 ? 'BEARISH' : 'NEUTRAL',
          score: Math.round((net / (c.bullish + c.bearish || 1)) * 100),
        };
      }
      const sorted = Object.entries(ccySummary).sort((a, b) => b[1].net - a[1].net);
      const strongest = sorted[0];
      const weakest = sorted[sorted.length - 1];
      const topPairs = Object.entries(layerData.pairBreaks)
        .map(([pair, d]) => ({
          pair, net: d.bullish - d.bearish,
          bullish: d.bullish, bearish: d.bearish,
          strong: d.strong, maxMag: d.maxMag,
        }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
      return {
        currencies: ccySummary,
        strongest: { currency: strongest[0], ...strongest[1] },
        weakest: { currency: weakest[0], ...weakest[1] },
        topPairs: topPairs.slice(0, 10),
        totalBreaks: topPairs.reduce((s, p) => s + p.bullish + p.bearish, 0),
      };
    }

    // Build final session summaries with H1/H3/H6 layers
    const sessions = Object.values(sessionBlocks).map(block => {
      const h1 = buildSessionSummary(block.h1);
      const h3 = buildSessionSummary(block.h3);
      const h6 = buildSessionSummary(block.h6);
      return {
        date: block.date, session: block.session, hours: block.hours,
        currencies: h1.currencies,
        strongest: h1.strongest, weakest: h1.weakest,
        topPairs: h1.topPairs, totalBreaks: h1.totalBreaks,
        h3: { currencies: h3.currencies, strongest: h3.strongest, weakest: h3.weakest, topPairs: h3.topPairs, totalBreaks: h3.totalBreaks },
        h6: { currencies: h6.currencies, strongest: h6.strongest, weakest: h6.weakest, topPairs: h6.topPairs, totalBreaks: h6.totalBreaks },
      };
    });

    sessions.sort((a, b) => {
      const dc = b.date.localeCompare(a.date);
      if (dc !== 0) return dc;
      const so = { NEW_YORK: 2, LONDON: 1, ASIA: 0 };
      return (so[b.session] || 0) - (so[a.session] || 0);
    });

    // Latest snapshot: most recent hour's currency state with H1/H3/H6
    const latest = hourlyScores.length ? hourlyScores[hourlyScores.length - 1] : null;

    // Currency momentum: trend of last N hours per currency (H1 based)
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

    // Per-pair break counts in last 3 hours — for flow pair ranking
    const last3h = hourlyScores.slice(-3);
    const recent3h = {};
    for (const lbKey of ['h1', 'h3', 'h6']) {
      recent3h[lbKey] = {};
      for (const hs of last3h) {
        const src = lbKey === 'h1' ? hs : hs[lbKey];
        if (!src) continue;
        for (const pb of (src.pairs || [])) {
          if (!recent3h[lbKey][pb.pair]) recent3h[lbKey][pb.pair] = { total: 0, strong: 0, bullish: 0, bearish: 0 };
          const r = recent3h[lbKey][pb.pair];
          r.total++;
          if (pb.strong) r.strong++;
          if (pb.type === 'BULLISH') r.bullish++; else r.bearish++;
        }
      }
    }

    // M15 structure breaks — last 3h of M15 candles for ranking boost
    const m15Since = new Date(Date.now() - 3 * 3600000).toISOString();
    const m15Breaks = {}; // { pair: { total, strong, bullish, bearish } }

    for (const inst of INSTRUMENTS) {
      const { data: m15Raw, error: m15Err } = await sb
        .from('backtest_candles')
        .select('time, open, high, low, close')
        .eq('instrument', inst)
        .eq('timeframe', 'M15')
        .eq('complete', true)
        .gte('time', m15Since)
        .order('time', { ascending: true })
        .limit(50);
      if (m15Err || !m15Raw?.length) continue;

      const candles = m15Raw.map(c => ({
        open: parseFloat(c.open), high: parseFloat(c.high),
        low: parseFloat(c.low), close: parseFloat(c.close),
      }));

      if (!m15Breaks[inst]) m15Breaks[inst] = { total: 0, strong: 0, bullish: 0, bearish: 0 };
      for (let i = 1; i < candles.length; i++) {
        const curr = candles[i], prev = candles[i - 1];
        let breakType = null, mag = 0;
        if (curr.close > prev.high) {
          breakType = 'BULLISH';
          mag = Math.round((curr.close - prev.high) * 100000) / 10;
        } else if (curr.close < prev.low) {
          breakType = 'BEARISH';
          mag = Math.round((prev.low - curr.close) * 100000) / 10;
        }
        if (breakType) {
          const body = Math.abs(curr.close - curr.open);
          const range = curr.high - curr.low;
          const bodyRatio = range > 0 ? body / range : 0;
          const isStrong = mag >= 1.5 && bodyRatio >= 0.5;
          m15Breaks[inst].total++;
          if (isStrong) m15Breaks[inst].strong++;
          if (breakType === 'BULLISH') m15Breaks[inst].bullish++;
          else m15Breaks[inst].bearish++;
        }
      }
    }

    recent3h.m15 = m15Breaks;

    res.json({
      latest,
      momentum,
      sessions,
      recent3h,
      sessionCount: sessions.length,
      totalHours: hourlyScores.length,
    });
  } catch (e) {
    console.error('[STRUCTURE-BREAK]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
