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

const NY_CLOSE_UTC = 21;
const LOOKBACK = 20;

function forexDayKey(iso) {
  const d = new Date(iso);
  if (d.getUTCHours() >= NY_CLOSE_UTC) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function prevTradingDay(dayKey) {
  const d = new Date(dayKey + 'T12:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 1) d.setUTCDate(d.getUTCDate() - 3);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Swing detection (k=1 for short windows) ──────────────────────────────
function detectSwings(candles) {
  const highs = [], lows = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high)
      highs.push({ idx: i, price: candles[i].high });
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low)
      lows.push({ idx: i, price: candles[i].low });
  }
  return { highs, lows };
}

// ─── 9-Metric Smooth Trend Score ──────────────────────────────────────────

function computeSmooth(window, direction, atr) {
  const n = window.length;
  if (n < 10) return null;
  const isBuy = direction === 'BUY';

  // 1. Directional Efficiency (15%) — net move / total path
  const netMove = Math.abs(window[n - 1].close - window[0].open);
  let totalPath = 0;
  for (let i = 1; i < n; i++) totalPath += Math.abs(window[i].close - window[i - 1].close);
  const de = totalPath > 0 ? Math.min(100, Math.round(netMove / totalPath * 100)) : 0;

  // 2. Persistence (10%) — candles closing in direction / total
  let inDir = 0;
  for (const c of window) {
    if (isBuy ? c.close > c.open : c.close < c.open) inDir++;
  }
  const persistence = Math.round(inDir / n * 100);

  // 3. Consecutive Closes (10%) — longest streak of same-direction closes
  let maxStreak = 0, streak = 0;
  for (const c of window) {
    if (isBuy ? c.close > c.open : c.close < c.open) { streak++; if (streak > maxStreak) maxStreak = streak; }
    else streak = 0;
  }
  const consecutive = Math.min(100, Math.round(maxStreak / n * 200));

  // 4. Wick Quality / Close Position (5%) — close near high (BUY) or low (SELL)
  let cpSum = 0;
  for (const c of window) {
    const r = c.high - c.low;
    if (r === 0) { cpSum += 50; continue; }
    cpSum += (isBuy ? (c.close - c.low) / r : (c.high - c.close) / r) * 100;
  }
  const wickQuality = Math.round(cpSum / n);

  // 5. Pullback Depth (5%) — shallow pullbacks = high score
  let impulses = [], pullbacks = [];
  let segStart = 0, prevInDir = isBuy ? window[0].close > window[0].open : window[0].close < window[0].open;
  for (let i = 1; i <= n; i++) {
    const curInDir = i < n ? (isBuy ? window[i].close > window[i].open : window[i].close < window[i].open) : !prevInDir;
    if (curInDir !== prevInDir || i === n) {
      const seg = window.slice(segStart, i);
      const move = Math.abs(seg[seg.length - 1].close - seg[0].open);
      if (prevInDir) impulses.push(move); else pullbacks.push(move);
      segStart = i;
      prevInDir = curInDir;
    }
  }
  const avgImp = impulses.length ? impulses.reduce((s, x) => s + x, 0) / impulses.length : 0;
  const avgPB = pullbacks.length ? pullbacks.reduce((s, x) => s + x, 0) / pullbacks.length : 0;
  const pullbackDepth = avgImp > 0 ? Math.max(0, Math.min(100, Math.round((1 - avgPB / avgImp) * 100))) : 50;

  // 6. H1 Structure (15%) — HH/HL (buy) or LH/LL (sell)
  const sw = detectSwings(window);
  let structCorrect = 0, structTotal = 0;
  for (let i = 1; i < sw.highs.length; i++) {
    structTotal++;
    if (isBuy ? sw.highs[i].price > sw.highs[i - 1].price : sw.highs[i].price < sw.highs[i - 1].price)
      structCorrect++;
  }
  for (let i = 1; i < sw.lows.length; i++) {
    structTotal++;
    if (isBuy ? sw.lows[i].price > sw.lows[i - 1].price : sw.lows[i].price < sw.lows[i - 1].price)
      structCorrect++;
  }
  const structure = structTotal > 0 ? Math.round(structCorrect / structTotal * 100) : 50;

  // 7. Swing Cleanliness (10%) — alternation quality + progressive quality
  const points = [
    ...sw.highs.map(h => ({ type: 'H', price: h.price, idx: h.idx })),
    ...sw.lows.map(l => ({ type: 'L', price: l.price, idx: l.idx })),
  ].sort((a, b) => a.idx - b.idx);

  let swingClean = 50;
  if (points.length >= 3) {
    let altOk = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].type !== points[i - 1].type) altOk++;
    }
    const altScore = altOk / (points.length - 1) * 100;

    let progOk = 0, progN = 0;
    let lastH = null, lastL = null;
    for (const p of points) {
      if (p.type === 'H') {
        if (lastH !== null) {
          progN++;
          if (isBuy ? p.price > lastH : p.price < lastH) progOk++;
        }
        lastH = p.price;
      } else {
        if (lastL !== null) {
          progN++;
          if (isBuy ? p.price > lastL : p.price < lastL) progOk++;
        }
        lastL = p.price;
      }
    }
    const progScore = progN > 0 ? progOk / progN * 100 : 50;
    swingClean = Math.round((altScore + progScore) / 2);
  }

  return { de, persistence, consecutive, wickQuality, pullbackDepth, structure, swingClean };
}

// Weekly/daily alignment strength — position within range normalized by ATR
function alignmentScore(close, open, atr) {
  if (atr <= 0) return 50;
  const move = Math.abs(close - open);
  return Math.min(100, Math.round(move / (atr * 5) * 100));
}

// Composite Smooth Trend Score (Daily 15% + 7 H1 metrics 85%)
function smoothTrendScore(dy, sub) {
  return Math.round(
    dy * 0.15 +
    sub.structure * 0.20 +
    sub.de * 0.20 +
    sub.persistence * 0.10 +
    sub.swingClean * 0.10 +
    sub.consecutive * 0.10 +
    sub.wickQuality * 0.08 +
    sub.pullbackDepth * 0.07
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

    const days = Math.min(30, parseInt(req.query?.days || '2', 10) || 2);
    const qFrom = req.query?.from;
    const qTo = req.query?.to;
    const until = qTo ? new Date(qTo + 'T23:59:59Z').toISOString() : new Date().toISOString();
    const since = qFrom ? new Date(qFrom + 'T00:00:00Z').toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const fetchSince = new Date(new Date(since).getTime() - 10 * 24 * 3600000).toISOString();

    // Fetch H1 candles
    const h1ByInst = {};
    for (let b = 0; b < INSTRUMENTS.length; b += 7) {
      const batch = INSTRUMENTS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async (inst) => {
        const allData = [];
        const PAGE = 1000;
        let offset = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, open, high, low, close')
            .eq('instrument', inst)
            .eq('timeframe', 'H1')
            .eq('complete', true)
            .gte('time', fetchSince)
            .lte('time', until)
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
        h1ByInst[inst] = data.map(c => ({
          time: c.time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        }));
      }
    }

    // Build daily OHLC
    const dailyOHLC = {};
    for (const inst of INSTRUMENTS) {
      const byDay = {};
      for (const c of (h1ByInst[inst] || [])) {
        const day = forexDayKey(c.time);
        if (!byDay[day]) byDay[day] = { open: c.open, high: c.high, low: c.low, close: c.close };
        else {
          if (c.high > byDay[day].high) byDay[day].high = c.high;
          if (c.low < byDay[day].low) byDay[day].low = c.low;
          byDay[day].close = c.close;
        }
      }
      dailyOHLC[inst] = byDay;
    }

    // Timestamps in range
    const allTimes = new Set();
    for (const inst of INSTRUMENTS) {
      for (const c of (h1ByInst[inst] || [])) {
        if (c.time >= since && c.time <= until) allTimes.add(c.time);
      }
    }
    const timestamps = [...allTimes].sort();

    // Index
    const indexByInst = {};
    for (const inst of INSTRUMENTS) {
      const candles = h1ByInst[inst] || [];
      const timeToIdx = {};
      for (let i = 0; i < candles.length; i++) timeToIdx[candles[i].time] = i;
      indexByInst[inst] = { candles, timeToIdx };
    }

    const rows = [];
    for (const time of timestamps) {
      const fxDay = forexDayKey(time);
      const prevDay = prevTradingDay(fxDay);
      const pairs = [];

      for (const inst of INSTRUMENTS) {
        const dayOH = (dailyOHLC[inst] || {})[fxDay];
        const prevDayOHLC = (dailyOHLC[inst] || {})[prevDay];
        if (!dayOH || !prevDayOHLC) continue;

        const { candles, timeToIdx } = indexByInst[inst];
        const idx = timeToIdx[time];
        if (idx === undefined) continue;

        const currentClose = candles[idx].close;

        // Daily + H1 direction alignment filter
        const dailyDir = currentClose > dayOH.open ? 'BUY' : currentClose < dayOH.open ? 'SELL' : null;
        if (!dailyDir) continue;
        const currentCandle = candles[idx];
        const h1Dir = currentCandle.close > currentCandle.open ? 'BUY' : currentCandle.close < currentCandle.open ? 'SELL' : null;
        if (!h1Dir) continue;
        if (dailyDir !== h1Dir) continue;
        const direction = dailyDir;

        // At least one of the last 2 daily candles must have closed in current direction
        const prev2Day = prevTradingDay(prevDay);
        const prev2DayOHLC = (dailyOHLC[inst] || {})[prev2Day];
        const d1Closed = prevDayOHLC.close > prevDayOHLC.open ? 'BUY' : prevDayOHLC.close < prevDayOHLC.open ? 'SELL' : null;
        const d2Closed = prev2DayOHLC ? (prev2DayOHLC.close > prev2DayOHLC.open ? 'BUY' : prev2DayOHLC.close < prev2DayOHLC.open ? 'SELL' : null) : null;
        if (d1Closed !== direction && d2Closed !== direction) continue;

        // Need enough lookback for sub-scores
        const start = Math.max(0, idx - LOOKBACK + 1);
        const window = candles.slice(start, idx + 1);
        if (window.length < 10) continue;

        // ATR from lookback window
        let atrSum = 0;
        for (const c of window) atrSum += c.high - c.low;
        const atr = atrSum / window.length;

        // Sub-scores
        const sub = computeSmooth(window, direction, atr);
        if (!sub) continue;

        // Daily alignment strength
        const dyScore = alignmentScore(currentClose, dayOH.open, atr);

        // Composite
        const score = smoothTrendScore(dyScore, sub);

        // H1 break bonus (previous day high/low)
        let h1Break = false;
        let breakLevel = null;
        if (direction === 'BUY' && currentClose > prevDayOHLC.high) {
          h1Break = true;
          breakLevel = prevDayOHLC.high;
        } else if (direction === 'SELL' && currentClose < prevDayOHLC.low) {
          h1Break = true;
          breakLevel = prevDayOHLC.low;
        }

        pairs.push({
          pair: inst.replace('_', '/'),
          direction,
          score,
          dyScore,
          de: sub.de,
          persistence: sub.persistence,
          consecutive: sub.consecutive,
          wickQuality: sub.wickQuality,
          pullbackDepth: sub.pullbackDepth,
          structure: sub.structure,
          swingClean: sub.swingClean,
          h1Break,
          breakLevel,
          close: currentClose,
          dayOpen: dayOH.open,
        });
      }

      if (!pairs.length) continue;
      // Rank pairs by Swing Clean (Swg) — it's a more direct measure of
      // structural quality than the smooth-trend composite, which mixes in
      // Daily + DE + Persistence + wicks and can flatten the ranking when
      // structure is really what we want to surface.
      pairs.sort((a, b) => b.swingClean - a.swingClean);

      rows.push({
        time,
        pairs: pairs.slice(0, 5),
        totalAligned: pairs.length,
      });
    }

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 90;
