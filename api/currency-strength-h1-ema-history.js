'use strict';

/**
 * GET /api/currency-strength-h1-ema-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Hourly per-currency strength from H1 close vs EMA20/EMA50 alignment,
 * across the requested window. Pre-fetches every pair's H1 candles once
 * (with a warmup buffer for EMA50) and walks hourly anchors in memory —
 * same shape as /api/acceleration-v4-history.
 *
 * Response:
 *   {
 *     from, to,
 *     hours: number,
 *     rows: [{ time, currencies: { USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD } }]
 *   }
 *
 * Values are strength/7 → bounded in [-1, +1].
 */

const { cors, getClient } = require('./_db');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];
const CCYS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];

// Rolling EMA — feed one value at a time, get the current EMA back.
function makeEma(period) {
  const k = 2 / (period + 1);
  let seedBuf = [];
  let e = null;
  return function push(v) {
    if (e === null) {
      seedBuf.push(v);
      if (seedBuf.length === period) {
        e = seedBuf.reduce((a, b) => a + b, 0) / period;
      }
      return e;
    }
    e = v * k + e * (1 - k);
    return e;
  };
}

async function fetchAllTf(sb, inst, tf, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', inst).eq('timeframe', tf).eq('complete', true)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({
      ms:   new Date(c.time).getTime(),
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
    })));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}
const fetchAllH1 = (sb, inst, since, until) => fetchAllTf(sb, inst, 'H1', since, until);

// Pip divisor: non-JPY pairs quote to 5 decimals so 1 pip = 0.0001; JPY
// pairs quote to 3 decimals so 1 pip = 0.01. Used to normalise body sizes
// across the 28 majors so the ranking is comparable.
function pipDiv(inst) { return inst.includes('JPY') ? 0.01 : 0.0001; }

function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50)  return +1.0;
  if (close < e20 && e20 < e50)  return -1.0;
  if (close > e20 && e20 <= e50) return +0.5;
  if (close < e20 && e20 >= e50) return -0.5;
  return 0;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const from = req.query?.from;
  const to   = req.query?.to;
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });

  const start = new Date(from + 'T00:00:00Z');
  const end   = new Date(to   + 'T23:00:00Z');
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'invalid dates' });

  const t0 = Date.now();
  const sb = getClient();

  // Need 51 candles of warmup for EMA50 → pull 5 extra days.
  const fetchSince = new Date(start.getTime() - 5 * 24 * 3600000).toISOString();
  const fetchUntil = new Date(end.getTime()   + 60 * 60000).toISOString();

  // Pre-fetch all 28 pairs, 7 at a time.
  const candles = {};
  const errors = [];
  for (let b = 0; b < PAIRS.length; b += 7) {
    const batch = PAIRS.slice(b, b + 7);
    await Promise.all(batch.map(async inst => {
      try { candles[inst] = await fetchAllH1(sb, inst, fetchSince, fetchUntil); }
      catch (e) { errors.push(`${inst}: ${e.message}`); candles[inst] = []; }
    }));
  }

  // Walk each hour in [start, end] and compute per-currency strength.
  // We rebuild rolling EMAs by streaming through each pair's candles once
  // and snapshotting at every hour boundary we care about.
  const targetHours = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 3600000) targetHours.push(t);
  const targetSet = new Set(targetHours);

  // For each pair, compute score at each target hour AND record whether the
  // current H1 close broke the highest high (BUY) or lowest low (SELL) of
  // the 6 immediately-preceding H1 candles. Records the breaking bar's body
  // size in pips so the frontend can rank setups by the strongest break.
  //
  // Also track a 20-candle trend-alignment window per pair: for each of the
  // last 20 completed candles, classify as 'above' (close > EMA20 AND >
  // EMA50), 'below' (close < both), or 'between'. Emitted on the break entry
  // as { above, below } counts so the frontend can gate setups on the
  // "≥ 10 of last 20 closed in trend direction" rule.
  // Impulse metrics accompany every break so the frontend can judge HOW
  // STRONG the move is, not just how many pips it covered. Raw pips aren't
  // comparable across pairs, so we normalise by a rolling ATR14:
  //   bodyAtr    = |close-open| / ATR14   → body vs the pair's typical range
  //   efficiency = |close-open| / (high-low) → how decisive (body vs wicks)
  //   impulse    = bodyAtr × efficiency × 100 → single comparable score
  //   breakAtr   = distance past the broken level, in ATRs
  const BREAK_LOOKBACK = 6;
  const TREND_LOOKBACK = 20;
  const ATR_PERIOD = 14;
  const DE_LOOKBACK = 20;   // window for directional efficiency
  const pairScores = {}; // { pair: Map<hourMs, score> }
  const pairBreaks = {}; // { pair: Map<hourMs, { direction, bodyPips, atrPips, bodyAtr, efficiency, impulse, breakAtr, above, below }> }
  for (const inst of PAIRS) {
    const seq = candles[inst] || [];
    if (!seq.length) { pairScores[inst] = new Map(); pairBreaks[inst] = new Map(); continue; }
    const pushE20 = makeEma(20);
    const pushE50 = makeEma(50);
    const scoreMap = new Map();
    const breakMap = new Map();
    const pd = pipDiv(inst);
    const prevWin = []; // last BREAK_LOOKBACK candles for high/low break
    const stateWin = []; // last TREND_LOOKBACK candles' classifications
    const trWin = [];    // rolling true-range window for ATR14
    const closeWin = []; // rolling closes for directional efficiency
    let prevClose = null;
    for (const c of seq) {
      // Rolling true range — the first bar has no previous close to compare.
      const tr = prevClose == null
        ? (c.high - c.low)
        : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      trWin.push(tr);
      if (trWin.length > ATR_PERIOD) trWin.shift();
      const atr = trWin.length === ATR_PERIOD
        ? trWin.reduce((a, b) => a + b, 0) / ATR_PERIOD
        : null;

      // Include the current close so DE reflects the window ending here.
      closeWin.push(c.close);
      if (closeWin.length > DE_LOOKBACK + 1) closeWin.shift();

      const e20 = pushE20(c.close);
      const e50 = pushE50(c.close);
      if (e20 != null && e50 != null) {
        let state = 'between';
        if (c.close > e20 && c.close > e50) state = 'above';
        else if (c.close < e20 && c.close < e50) state = 'below';
        stateWin.push(state);
        if (stateWin.length > TREND_LOOKBACK) stateWin.shift();
      }
      if (e20 != null && e50 != null && targetSet.has(c.ms)) {
        scoreMap.set(c.ms, alignmentScore(c.close, e20, e50));
        if (prevWin.length >= BREAK_LOOKBACK && atr) {
          let maxH = -Infinity, minL = Infinity;
          for (const p of prevWin) { if (p.high > maxH) maxH = p.high; if (p.low < minL) minL = p.low; }
          const body  = Math.abs(c.close - c.open);
          const range = c.high - c.low;
          const bodyPips   = Math.round((body / pd) * 10) / 10;
          const atrPips    = Math.round((atr  / pd) * 10) / 10;
          const bodyAtr    = Math.round((body / atr) * 100) / 100;
          const efficiency = range > 0 ? Math.round((body / range) * 100) / 100 : 0;
          const impulse    = Math.round(bodyAtr * efficiency * 100);
          // Directional efficiency: net displacement / total path travelled
          // over the window. ~1.0 = a straight run, ~0.1 = pure chop. This is
          // what separates a real trend from price oscillating around the EMA.
          let de = 0;
          if (closeWin.length >= DE_LOOKBACK + 1) {
            let path = 0;
            for (let i = 1; i < closeWin.length; i++) path += Math.abs(closeWin[i] - closeWin[i - 1]);
            if (path > 0) {
              const net = Math.abs(closeWin[closeWin.length - 1] - closeWin[0]);
              de = Math.round((net / path) * 100) / 100;
            }
          }
          // Count trend-aligned closes over the last TREND_LOOKBACK bars.
          let above = 0, below = 0;
          for (const s of stateWin) { if (s === 'above') above++; else if (s === 'below') below++; }
          if (c.close > maxH) {
            const breakAtr = Math.round(((c.close - maxH) / atr) * 100) / 100;
            breakMap.set(c.ms, { direction: 'BUY',  bodyPips, atrPips, bodyAtr, efficiency, impulse, breakAtr, de, above, below });
          } else if (c.close < minL) {
            const breakAtr = Math.round(((minL - c.close) / atr) * 100) / 100;
            breakMap.set(c.ms, { direction: 'SELL', bodyPips, atrPips, bodyAtr, efficiency, impulse, breakAtr, de, above, below });
          }
        }
      }
      prevWin.push(c);
      if (prevWin.length > BREAK_LOOKBACK) prevWin.shift();
      prevClose = c.close;
    }
    pairScores[inst] = scoreMap;
    pairBreaks[inst] = breakMap;
  }

  // Aggregate per hour across all 28 pairs.
  const rows = [];
  for (const h of targetHours) {
    // Skip weekend hours: Sat all day, Sun before 21:00 UTC.
    const d = new Date(h);
    const dow = d.getUTCDay();
    const hr  = d.getUTCHours();
    if (dow === 6) continue;
    if (dow === 0 && hr < 21) continue;

    const agg = {}; CCYS.forEach(k => agg[k] = 0);
    let contributing = 0;
    for (const inst of PAIRS) {
      const s = pairScores[inst].get(h);
      if (s === undefined) continue;
      contributing++;
      const [base, quote] = inst.split('_');
      agg[base]  += s;
      agg[quote] -= s;
    }
    if (contributing < PAIRS.length * 0.7) continue; // skip hours with too few pairs
    const currencies = {};
    for (const k of CCYS) currencies[k] = agg[k] / 7;
    // Per-anchor break map: pair → break record for pairs whose current H1
    // broke the 6-candle high/low, with the impulse metrics attached.
    const breaks = {};
    for (const inst of PAIRS) {
      const b = pairBreaks[inst].get(h);
      if (b) breaks[inst] = b;
    }
    rows.push({ time: d.toISOString(), currencies, breaks });
  }

  res.json({
    from, to,
    hours: rows.length,
    duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    errors: errors.slice(0, 5),
    rows,
  });
};

module.exports.maxDuration = 300;
