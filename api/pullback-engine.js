'use strict';

/**
 * GET /api/pullback-engine  — Pullback-Continuation Engine
 *
 * Separates DIRECTION (H1) from EXECUTION (M15) across 28 pairs.
 *
 *  H1 layer   — trend from EMA20/EMA50 structure (survives pullbacks), trend
 *               integrity (EMA20 must stay the right side of EMA50), and an
 *               EMA-based currency-strength ranking (-100..+100).
 *  M15 layer  — same EMAs used to spot the pullback (price loses EMA alignment
 *               / currency rotates to NEUTRAL) and the realignment (price +
 *               EMA + currency snap back into the H1 direction).
 *
 * State per pair: NO_TREND → WAIT → PULLBACK → ENTRY, with REVERSAL_RISK when
 * M15 currency strength flips against the H1 trend (strong→weak / weak→strong).
 * A 0–100 signal score prioritises the cleanest setups.
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
const STRONG_TH = 33, WEAK_TH = -33;   // classify normalised strength (-100..+100)

// EMA over an ascending close series → array (null until it seeds).
function emaSeries(vals, period) {
  const k = 2 / (period + 1);
  const out = []; let e = null; const seed = [];
  for (let i = 0; i < vals.length; i++) {
    if (e === null) { seed.push(vals[i]); if (seed.length === period) e = seed.reduce((a, b) => a + b, 0) / period; out.push(e); }
    else { e = vals[i] * k + e * (1 - k); out.push(e); }
  }
  return out;
}

// Walk the M15 alignment sequence (relative to the H1 direction) to enforce
// TREND → PULLBACK → ENTRY. `struct[i]` = EMA20/EMA50 on the trend's side;
// `aligned[i]` = full stack incl. price. Returns the current phase.
function computePhase(struct, aligned) {
  let last = struct.length - 1;
  while (last >= 0 && struct[last] == null) last--;
  if (last < 0) return 'NONE';
  if (struct[last] === false) return 'M15_REVERSED';    // M15 EMA stack flipped against H1
  if (aligned[last] === false) return 'PULLBACK';        // structure intact, price pulled back
  // Aligned now — measure the fresh aligned run.
  let alignRun = 0, i = last;
  for (; i >= 0 && struct[i] === true && aligned[i] === true; i--) alignRun++;
  // The stretch immediately before it must be a pullback (structure intact, not aligned)…
  let pbRun = 0, k = i;
  for (; k >= 0 && struct[k] === true && aligned[k] === false; k--) pbRun++;
  // …preceded by an aligned stretch (the established trend).
  const priorAligned = (k >= 0 && struct[k] === true && aligned[k] === true);
  if (pbRun > 0 && priorAligned) return alignRun <= 4 ? 'ENTRY' : 'TREND';   // fresh realign = ENTRY
  return 'TREND';                                         // continuously aligned = trend already running
}

// Currency-strength alignment score for one pair (±1 clean stack, ±0.5 partial).
function alignmentScore(close, e20, e50) {
  if (close > e20 && e20 > e50) return 1;
  if (close < e20 && e20 < e50) return -1;
  if (close > e20 && e20 <= e50) return 0.5;
  if (close < e20 && e20 >= e50) return -0.5;
  return 0;
}
const classify = (s) => (s >= STRONG_TH ? 'STRONG' : s <= WEAK_TH ? 'WEAK' : 'NEUTRAL');

async function fetchCloses(sb, inst, tf, limit, until) {
  let q = sb.from('backtest_candles')
    .select('close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (until) q = q.lte('time', until);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(c => +c.close).reverse();   // ascending
}

async function fetchOHLC(sb, inst, tf, limit, until) {
  let q = sb.from('backtest_candles')
    .select('open, high, low, close')
    .eq('instrument', inst).eq('timeframe', tf).eq('complete', true);
  if (until) q = q.lte('time', until);
  const { data, error } = await q.order('time', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(c => ({ open: +c.open, high: +c.high, low: +c.low, close: +c.close })).reverse();
}

function atr14FromOHLC(c) {
  if (c.length < 2) return null;
  const trs = [];
  for (let i = 1; i < c.length; i++) trs.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  const last = trs.slice(-14);
  return last.length ? last.reduce((a, b) => a + b, 0) / last.length : null;
}

// Activity / pressure — how hard the trend is pushing, from the last N trend-TF
// candles measured in the trend direction. Blends ATR-normalised distance (0.5),
// directional efficiency (0.3) and body dominance (0.2) → 0..100, plus a label.
function pressureFrom(candles, dirSign) {
  const N = 14;
  if (!candles || candles.length < N + 1) return null;
  const atr = atr14FromOHLC(candles);
  if (!atr || atr <= 0) return null;
  const win = candles.slice(-N);
  const net = (win[N - 1].close - win[0].close) * dirSign;      // distance in trend dir
  const dispATR = net / atr;
  let path = 0; for (let i = 1; i < N; i++) path += Math.abs(win[i].close - win[i - 1].close);
  const efficiency = path > 0 ? Math.abs(win[N - 1].close - win[0].close) / path : 0;
  let bodySum = 0, cnt = 0;
  for (const c of win) { const r = c.high - c.low; if (r > 0) { bodySum += Math.abs(c.close - c.open) / r; cnt++; } }
  const bodyDom = cnt ? bodySum / cnt : 0;
  const dispScore = Math.max(0, Math.min(1, dispATR / 6));       // ~6 ATR over the window = max
  const pressure = Math.round(100 * (0.5 * dispScore + 0.3 * efficiency + 0.2 * bodyDom));
  // Exhaustion: momentum in the recent half has faded vs the earlier half.
  const half = Math.floor(N / 2);
  const recent = (win[N - 1].close - win[N - 1 - half].close) * dirSign / atr;
  const earlier = (win[N - 1 - half].close - win[0].close) * dirSign / atr;
  const decel = earlier > 1 && recent < earlier * 0.4;
  let activity;
  if (decel && pressure >= 35) activity = 'Exhausting';
  else if (pressure < 18) activity = 'Sleeping';
  else if (pressure < 38) activity = 'Building';
  else if (pressure < 60) activity = 'Expanding';
  else activity = 'Exploding';
  return { pressure, activity, dispATR: +dispATR.toFixed(2), efficiency: +efficiency.toFixed(2), bodyDom: +bodyDom.toFixed(2) };
}

// Did the last trend-TF candle break the prior 5 candles' high (buy) / low
// (sell)? A trend-direction breakout gate — pairs that fail are dropped.
function brokeStructure(candles, dirSign) {
  if (!candles || candles.length < 6) return false;
  const n = candles.length, last = candles[n - 1];
  let hi = -Infinity, lo = Infinity;
  for (let i = n - 6; i < n - 1; i++) { if (candles[i].high > hi) hi = candles[i].high; if (candles[i].low < lo) lo = candles[i].low; }
  return dirSign > 0 ? last.high > hi : last.low < lo;
}

// Market-wide regime summary (over all pairs that have a trend).
function summarize(pairs) {
  const active = pairs.filter(p => p.state !== 'NO_TREND');
  const order = ['Exploding', 'Expanding', 'Building', 'Exhausting', 'Sleeping'];
  let top = null; for (const a of order) if (active.some(p => p.activity === a)) { top = a; break; }
  return {
    active: active.length,
    trend: active.filter(p => p.state === 'TREND' || p.state === 'ENTRY').length,
    reversal: active.filter(p => p.state === 'REVERSAL_RISK').length,
    moving: active.filter(p => p.pressure >= 38).length,
    topActivity: top,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    // History: ?at=<ISO> evaluates the engine as of that instant.
    const HOUR = 3600000, M15 = 900000;
    const now = Date.now();
    let evalMs = now;
    if (req.query?.at) { const t = new Date(req.query.at).getTime(); if (!isNaN(t)) evalMs = Math.min(t, now); }
    // Use SIGNAL (close) time, not candle-open time: only include candles that
    // have closed by evalMs. DB `time` = open, so a candle closes at open+TF;
    // bound the open time to evalMs − TF so nothing closing after evalMs leaks in.
    const untilH1 = new Date(evalMs - HOUR).toISOString();
    const untilM15 = new Date(evalMs - M15).toISOString();
    const signalMs = Math.floor(evalMs / M15) * M15;   // last M15 close at/before evalMs

    // Per-pair H1 + M15 EMA snapshot (as of the latest closed candles).
    const px = {};
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const rows = await Promise.all(batch.map(async inst => {
        const [h1ohlc, m15c] = await Promise.all([fetchOHLC(sb, inst, 'H1', 220, untilH1), fetchCloses(sb, inst, 'M15', 220, untilM15)]);
        const h1c = h1ohlc.map(c => c.close);
        const series = (closes) => (closes.length < 51 ? null : { closes, s20: emaSeries(closes, 20), s50: emaSeries(closes, 50) });
        const snapOf = (X) => {
          if (!X) return null;
          const i = X.closes.length - 1, e20 = X.s20[i], e50 = X.s50[i], price = X.closes[i];
          if (e20 == null || e50 == null) return null;
          const sign = Math.sign(e20 - e50);
          let bars = 0;
          for (let j = i; j >= 0 && X.s20[j] != null && X.s50[j] != null && Math.sign(X.s20[j] - X.s50[j]) === sign; j--) bars++;
          return { price, e20, e50, bars, align: alignmentScore(price, e20, e50) };
        };
        const H = series(h1c), M = series(m15c);
        const h1 = snapOf(H), m15 = snapOf(M);
        // M15 phase (TREND/PULLBACK/ENTRY/…) evaluated in the H1 trend direction.
        let phase = 'NONE';
        if (H && M && h1 && m15) {
          const isBuy = h1.e20 > h1.e50, isBear = h1.e20 < h1.e50;
          if (isBuy || isBear) {
            const struct = [], aligned = [];
            for (let i = 0; i < M.closes.length; i++) {
              const e2 = M.s20[i], e5 = M.s50[i];
              if (e2 == null || e5 == null) { struct.push(null); aligned.push(null); continue; }
              const c = M.closes[i];
              struct.push(isBuy ? (e2 > e5) : (e2 < e5));
              aligned.push(isBuy ? (c > e2 && e2 > e5) : (c < e2 && e2 < e5));
            }
            phase = computePhase(struct, aligned);
          }
        }
        return { inst, h1, m15, phase, h1ohlc: h1ohlc.slice(-40) };
      }));
      for (const r of rows) px[r.inst] = r;
    }

    // Currency strength (H1 + M15): sum of per-pair alignment (base +, quote -),
    // /7 → [-1,1] → ×100.
    const strength = (tf) => {
      const acc = {}; CCYS.forEach(c => acc[c] = 0);
      for (const inst of PAIRS) {
        const s = px[inst] && px[inst][tf];
        if (!s) continue;
        const [base, quote] = inst.split('_');
        acc[base] += s.align; acc[quote] -= s.align;
      }
      const out = {};
      CCYS.forEach(c => { out[c] = Math.round((acc[c] / 7) * 100); });
      return out;
    };
    const sH1 = strength('h1'), sM15 = strength('m15');
    const ranked = (s) => CCYS.map(c => ({ currency: c, strength: s[c], state: classify(s[c]) })).sort((a, b) => b.strength - a.strength);

    const qualityOf = (sc) => (sc >= 90 ? 'A+' : sc >= 80 ? 'High' : sc >= 70 ? 'Tradable' : 'Ignore');

    const pairs = [];
    for (const inst of PAIRS) {
      const P = px[inst];
      if (!P || !P.h1 || !P.m15) continue;
      const [base, quote] = inst.split('_');
      const h1 = P.h1, m15 = P.m15;
      const bH1 = classify(sH1[base]), qH1 = classify(sH1[quote]);
      const bM15 = classify(sM15[base]), qM15 = classify(sM15[quote]);

      const h1Bull = h1.e20 > h1.e50, h1Bear = h1.e20 < h1.e50;
      const dir = h1Bull ? 'BUY' : h1Bear ? 'SELL' : null;
      const phase = P.phase;
      const pr = dir ? pressureFrom(P.h1ohlc, dir === 'BUY' ? 1 : -1) : null;
      const broke = dir ? brokeStructure(P.h1ohlc, dir === 'BUY' ? 1 : -1) : false;

      let state, score = 0;
      if (!dir) {
        state = 'NO_TREND';
      } else {
        const isBuy = dir === 'BUY';
        const h1FullPrice = isBuy ? (h1.price > h1.e20 && h1.e20 > h1.e50) : (h1.price < h1.e20 && h1.e20 < h1.e50);
        const h1CcyOk = isBuy ? (bH1 === 'STRONG' && qH1 === 'WEAK') : (bH1 === 'WEAK' && qH1 === 'STRONG');
        const h1CcyHalf = isBuy ? (bH1 === 'STRONG' || qH1 === 'WEAK') : (bH1 === 'WEAK' || qH1 === 'STRONG');
        const m15CcyMatch = isBuy ? (bM15 === 'STRONG' && qM15 === 'WEAK') : (bM15 === 'WEAK' && qM15 === 'STRONG');
        const m15Flipped = isBuy ? (bM15 === 'WEAK' || qM15 === 'STRONG') : (bM15 === 'STRONG' || qM15 === 'WEAK');

        // Score (weights: 30 / 25 / 15 / 15 / 15). Realignment only credits a
        // fresh post-pullback entry, partial for an already-running trend.
        score += h1FullPrice ? 30 : 15;                          // H1 EMA structure
        score += h1CcyOk ? 25 : h1CcyHalf ? 13 : 0;              // H1 strength separation
        score += 15;                                             // H1 integrity (in-trend)
        score += m15Flipped ? 0 : 15;                            // M15 pullback quality (no currency flip)
        score += phase === 'ENTRY' ? 15 : phase === 'TREND' ? 10 : 0;   // M15 realignment

        // ENTRY requires the sequence trend → pullback → fresh realignment.
        if (m15Flipped || phase === 'M15_REVERSED') state = 'REVERSAL_RISK';
        else if (phase === 'ENTRY' && h1CcyOk && m15CcyMatch) state = 'ENTRY';
        else if (phase === 'PULLBACK') state = 'PULLBACK';
        else if (phase === 'TREND') state = h1CcyOk ? 'TREND' : 'WAIT';
        else state = 'WAIT';
      }

      pairs.push({
        pair: inst.replace('_', '/'), instrument: inst, direction: dir, phase, broke,
        state, score, quality: qualityOf(score),
        pressure: pr ? pr.pressure : 0, activity: pr ? pr.activity : 'Sleeping',
        pressureDetail: pr ? { dispATR: pr.dispATR, efficiency: pr.efficiency, bodyDom: pr.bodyDom } : null,
        h1: {
          trend: h1Bull ? 'BULL' : h1Bear ? 'BEAR' : 'FLAT', bars: h1.bars,
          price: +h1.price.toFixed(6), e20: +h1.e20.toFixed(6), e50: +h1.e50.toFixed(6),
          base: sH1[base], quote: sH1[quote], baseState: bH1, quoteState: qH1,
        },
        m15: {
          trend: (m15.e20 > m15.e50) ? 'BULL' : (m15.e20 < m15.e50) ? 'BEAR' : 'FLAT',
          price: +m15.price.toFixed(6), e20: +m15.e20.toFixed(6), e50: +m15.e50.toFixed(6),
          base: sM15[base], quote: sM15[quote], baseState: bM15, quoteState: qM15,
        },
      });
    }
    const summary = summarize(pairs);                    // regime over the full board
    const shown = pairs.filter(p => p.broke).sort((a, b) => b.score - a.score);   // last-candle break gate

    res.json({
      generatedAt: new Date(signalMs).toISOString(),   // signal (candle-close) time
      thresholds: { strong: STRONG_TH, weak: WEAK_TH },
      currencies: { h1: ranked(sH1), m15: ranked(sM15) },
      summary,
      pairs: shown,
    });
  } catch (e) {
    console.error('[pullback-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
