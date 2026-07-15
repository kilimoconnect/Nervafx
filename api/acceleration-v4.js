'use strict';

/**
 * Forex Acceleration Engine v4.0
 *
 * Architecture:
 *   H1  -> Market Bias / Institutional Direction    (30% + optional 10%)
 *   M15 -> Acceleration Engine / Pair Selection     (60%)
 *
 * H1 gives permission (direction). M15 gives the opportunity (acceleration).
 *
 * Live mode:  GET /api/acceleration-v4
 * Historical: GET /api/acceleration-v4?date=YYYY-MM-DD&time=HH:MM
 *             (anchor is snapped to the previous complete M15 candle)
 */

const { getClient, cors } = require('./_db');
const { requirePlan } = require('./_plan');

const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function isJpy(inst) { return inst.includes('JPY'); }
function pipDiv(inst) { return isJpy(inst) ? 0.01 : 0.0001; }

// ── H1 EMA per-currency strength ────────────────────────────────────────────
// Same maths as /api/currency-strength-h1-ema: score each pair's close vs
// EMA20/EMA50, credit base +score, quote -score, divide by 7. Used to gate
// pair selection so we only keep pairs where the strong currency aligns with
// the trade direction (e.g. BUY AUD_USD → AUD strong AND USD weak).
const CCYS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
const STRENGTH_STRONG = 0.20;
const STRENGTH_WEAK   = -0.20;

// Discrete stack-alignment score used by the per-currency strength gate on
// both variants. Timeframe-agnostic — takes whichever candle series (H1 for
// the H1 page, M15 for the M15 page) and evaluates close vs EMA20 vs EMA50.
function stackAlignmentScore(candles) {
  if (!candles || candles.length < 51) return null;
  const closes = candles.map(c => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const c   = closes[closes.length - 1];
  if (e20 == null || e50 == null) return null;
  if (c > e20 && e20 > e50)  return +1.0;
  if (c < e20 && e20 < e50)  return -1.0;
  if (c > e20 && e20 <= e50) return +0.5;
  if (c < e20 && e20 >= e50) return -0.5;
  return 0;
}
const h1AlignmentScore = stackAlignmentScore; // back-compat alias

// M15 EMA-slope strength — measures how steep the M15 EMA20 line is over the
// last 10 candles, normalised by ATR14. Signed only when the price + EMA20 +
// EMA50 stack agrees with the slope direction; otherwise treated as flat.
//
// Layer 1 of the user's design: pick pairs where the M15 EMA20 line is really
// trending, not just barely positive. A deep slope means the trend has energy.
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [seed];
  for (let i = period; i < values.length; i++) {
    out.push(values[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

// Raw slope/ATR classification exactly per the spec:
//   0.00 - 0.10  Flat
//   0.10 - 0.30  Shallow
//   0.30 - 0.60  Strong
//   0.60+        Deep
function slopeClassification(abs) {
  if (abs < 0.10) return 'FLAT';
  if (abs < 0.30) return 'SHALLOW';
  if (abs < 0.60) return 'STRONG';
  return 'DEEP';
}

// Linear regression slope through an ordered numeric series.
// slope = Σ(x - x̄)(y - ȳ) / Σ(x - x̄)²
function regressionSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (values[i] - yMean);
    den += dx * dx;
  }
  return num / den;
}

// Trend Geometry Engine — five components together, distinguishing healthy
// trends from overextended ones:
//   1. EMA20 slope over last 5 candles (regression) — trend SPEED
//   2. EMA50 slope over last 5 candles              — trend STABILITY
//   3. Price position: avg(|D20|, |D50|) in ATRs    — trend STRETCH
//   4. EMA20 / EMA50 separation in ATRs             — trend WIDTH
//   5. Pullback quality:
//        (|EMA20-EMA50| - |close-EMA20|) / |EMA20-EMA50|
//      1.0 = price sitting on EMA20, 0.0 = price at EMA50 or beyond,
//      negative → price stretched past the EMA20-EMA50 separation
//      (clamped to 0).
//
// Composite (signed, capped to ±1):
//   35 % EMA20 slope
//   25 % EMA50 slope
//   20 % price position
//   10 % EMA20-EMA50 separation
//   10 % pullback quality
//
// Overextension penalty: when |close - EMA20| / ATR > 1.5 the composite
// gets multiplied by (1 - min((extension - 1.5) × 0.6, 0.5)) — up to a
// 50 % score cut at extension 2.33 ATR and beyond. Kills the case where
// slope + slope + position all look great but price is so stretched that
// the next M15 is far more likely to pull back than continue.
function m15SlopeScore(m15Slice) {
  if (!m15Slice || m15Slice.length < 60) return null;
  const closes = m15Slice.map(c => c.close);
  const e20Series = emaSeries(closes, 20);
  const e50Series = emaSeries(closes, 50);
  if (e20Series.length < 5 || e50Series.length < 5) return null;
  const e50 = e50Series[e50Series.length - 1];

  const a14 = atr(m15Slice, 14);
  if (!a14 || a14 === 0) return null;

  const cur = closes[closes.length - 1];
  const e20 = e20Series[e20Series.length - 1];

  // Layer 2 — stack aligned with direction.
  let stackSign = 0;
  if (cur > e20 && e20 > e50)      stackSign = +1;
  else if (cur < e20 && e20 < e50) stackSign = -1;
  if (stackSign === 0) return 0;

  // EMA20 vs EMA50 aligned across EVERY candle in the window.
  const e20Window = e20Series.slice(-5);
  const e50Window = e50Series.slice(-5);
  for (let i = 0; i < 5; i++) {
    if (stackSign === +1 && !(e20Window[i] > e50Window[i])) return 0;
    if (stackSign === -1 && !(e20Window[i] < e50Window[i])) return 0;
  }

  // Component 1: EMA20 slope (trend speed), ATR-normalised.
  const slope20 = regressionSlope(e20Window) / a14;
  if (Math.sign(slope20) !== stackSign) return 0;

  // Component 2: EMA50 slope (trend stability). Tolerates up to 0.05 ATR
  // of counter-slope as flat — EMA50 lags, doesn't have to keep pace.
  const slope50 = regressionSlope(e50Window) / a14;
  if (Math.sign(slope50) !== stackSign && Math.abs(slope50) > 0.05) return 0;

  // Component 3: Price position — |D20| + |D50| average, in ATRs.
  const d20 = Math.abs(cur - e20) / a14;
  const d50 = Math.abs(cur - e50) / a14;
  const positionAvg = (d20 + d50) / 2;

  // Component 4: EMA20 vs EMA50 separation — width of the stack.
  const emaSep = Math.abs(e20 - e50) / a14;

  // Component 5: Pullback quality — high when price hugs EMA20, low when
  // price has drifted toward or past EMA50. Clamped to [0, 1] so a price
  // stretched past |EMA20-EMA50| doesn't turn negative and mislead the
  // composite; the extension penalty below handles that case.
  let pullbackQuality = 0;
  if (emaSep > 0.01) {
    pullbackQuality = (Math.abs(e20 - e50) - Math.abs(cur - e20)) / Math.abs(e20 - e50);
    pullbackQuality = Math.max(0, Math.min(1, pullbackQuality));
  }

  // Raw M15 4-candle net move must confirm direction (0.10 ATR dead-zone).
  const close4Ago = closes[closes.length - 5];
  const rawMove = (cur - close4Ago) / a14;
  const rawSign = Math.abs(rawMove) < 0.10 ? 0 : Math.sign(rawMove);
  if (rawSign !== stackSign) return 0;

  const s20 = Math.min(Math.abs(slope20), 1.0);
  const s50 = Math.min(Math.abs(slope50), 1.0);
  const pos = Math.min(positionAvg,       1.0);
  const sep = Math.min(emaSep,            1.0);
  const pbq = pullbackQuality;

  let composite =
    s20 * 0.35 +
    s50 * 0.25 +
    pos * 0.20 +
    sep * 0.10 +
    pbq * 0.10;

  // Overextension penalty — price too far above/below EMA20 raises pullback
  // risk. Zero penalty up to 1.5 ATR, then linear cut peaking at 50 % off
  // by 2.33 ATR of extension.
  const extension = d20; // |close - EMA20| / ATR14
  if (extension > 1.5) {
    const penalty = Math.min((extension - 1.5) * 0.6, 0.5);
    composite *= (1 - penalty);
  }

  return stackSign * composite;
}

module.exports.slopeClassification = slopeClassification;

// Per-currency strength for the alignment gate. Both variants use the same
// discrete stack-alignment score (close vs EMA20 vs EMA50); the only
// difference is the candle series — H1 for the H1 variant, M15 for the M15
// variant. The M15 slope composite is only for pair *ranking*, not for
// currency-strength aggregation, so the extreme ±1 requirement still means
// "every one of that currency's 7 pairs is cleanly stacked".
function computeCurrencyStrength(pairMap /*, mode — kept for signature compat */) {
  const agg = {};
  CCYS.forEach(k => agg[k] = 0);
  for (const inst of VALID_PAIRS) {
    const s = stackAlignmentScore(pairMap[inst]);
    if (s == null) continue;
    const [base, quote] = inst.split('_');
    agg[base]  += s;
    agg[quote] -= s;
  }
  const out = {};
  for (const k of CCYS) out[k] = agg[k] / 7;
  return out;
}

function strengthAligned(inst, direction, strength, mode) {
  if (!direction || !strength) return false;
  const [base, quote] = inst.split('_');
  const bs = strength[base] ?? 0;
  const qs = strength[quote] ?? 0;
  // Currency-strength aggregation uses the discrete stack-alignment score in
  // both variants, so the extreme requirement is the same regardless of mode:
  // at least one of the two currencies must have every one of its 7 pairs
  // cleanly stacked in the same direction (|strength| ≥ 1.0).
  const extreme = Math.abs(bs) >= 0.999 || Math.abs(qs) >= 0.999;
  if (!extreme) return false;
  if (direction === 'BUY')  return bs >= STRENGTH_STRONG && qs <= STRENGTH_WEAK;
  if (direction === 'SELL') return bs <= STRENGTH_WEAK   && qs >= STRENGTH_STRONG;
  return false;
}

// ── Indicators ──────────────────────────────────────────────────────────────
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atr(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low  - p.close),
    );
    trs.push(tr);
  }
  const window = trs.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

// ── Component scores ───────────────────────────────────────────────────────
function h1BiasScore(h1, opts) {
  const requireBreakout = !opts || opts.requireBreakout !== false;
  if (h1.length < 51) return { direction: null, score: 0, closePx: null, ema20: null, ema50: null };
  const closes = h1.map(c => c.close);

  // Compute EMA20 and EMA50 at the current close AND at the previous close.
  // Both closes must sit on the aligned side of BOTH EMAs, and both EMA20
  // readings must sit on the aligned side of both EMA50 readings, before we
  // register a bias. Prevents single-candle whipsaws from flipping direction.
  const closesPrev = closes.slice(0, -1);
  const e20Now  = ema(closes,      20);
  const e50Now  = ema(closes,      50);
  const e20Prev = ema(closesPrev,  20);
  const e50Prev = ema(closesPrev,  50);
  const cNow    = closes[closes.length - 1];
  const cPrev   = closes[closes.length - 2];
  const hPrev   = h1[h1.length - 2].high;
  const lPrev   = h1[h1.length - 2].low;

  if (e20Now == null || e50Now == null || e20Prev == null || e50Prev == null) {
    return { direction: null, score: 0, closePx: cNow, ema20: e20Now, ema50: e50Now };
  }

  // Structural break: current H1 must close beyond the previous H1's high
  // (BUY) or low (SELL). Pairs that only sit inside the previous H1's range
  // don't earn direction.
  const breakoutUp   = cNow > hPrev;
  const breakoutDown = cNow < lPrev;

  const bullish =
    cNow  > e20Now  && cPrev > e20Prev &&
    e20Now > e50Now && e20Prev > e50Prev &&
    (!requireBreakout || breakoutUp);
  const bearish =
    cNow  < e20Now  && cPrev < e20Prev &&
    e20Now < e50Now && e20Prev < e50Prev &&
    (!requireBreakout || breakoutDown);

  let direction = null;
  let score = 0;
  if (bullish)      { direction = 'BUY';  score = 100; }
  else if (bearish) { direction = 'SELL'; score = 100; }

  return {
    direction,
    score,
    closePx: cNow,
    ema20: e20Now,
    ema50: e50Now,
    breakoutUp,
    breakoutDown,
    prevHigh: hPrev,
    prevLow:  lPrev,
    // Debug snapshot of both H1 readings so the detail modal can prove exactly
    // which H1 (current or previous) satisfied / failed the alignment rule.
    now:  { close: cNow,  ema20: e20Now,  ema50: e50Now,
            aboveEma20: cNow  > e20Now,  belowEma20: cNow  < e20Now,
            e20AboveE50: e20Now > e50Now, e20BelowE50: e20Now < e50Now },
    prev: { close: cPrev, ema20: e20Prev, ema50: e50Prev, high: hPrev, low: lPrev,
            aboveEma20: cPrev > e20Prev, belowEma20: cPrev < e20Prev,
            e20AboveE50: e20Prev > e50Prev, e20BelowE50: e20Prev < e50Prev },
  };
}

function h1MomentumScore(h1) {
  const period = 14;
  if (h1.length < period + 4) return { score: 0, velocity: 0 };
  const a = atr(h1, period);
  if (!a || a === 0) return { score: 0, velocity: 0 };
  const last = h1[h1.length - 1].close;
  const three = h1[h1.length - 4].close;
  const v = Math.abs(last - three) / a;
  const score = Math.min(v * 33, 100);
  return { score: Math.round(score * 10) / 10, velocity: Math.round(v * 100) / 100 };
}

function m15VelocityScore(m15) {
  const period = 14;
  if (m15.length < period + 5) return { score: 0, velocity: 0, signed: 0 };
  const a = atr(m15, period);
  if (!a || a === 0) return { score: 0, velocity: 0, signed: 0 };
  const c0 = m15[m15.length - 1].close;
  const c4 = m15[m15.length - 5].close;
  const signed = (c0 - c4) / a;
  const v = Math.abs(signed);
  // Cap raw velocity contribution at 2.0 ATR: anything faster is almost always
  // a news spike, not a sustainable trend, so it saturates at 100 without
  // dominating the composite. Linear ramp up to 2.0 → score of 100.
  const score = Math.min(v, 2.0) * 50;
  return { score: Math.round(score * 10) / 10, velocity: Math.round(v * 100) / 100, signed: Math.round(signed * 100) / 100 };
}

function m15AccelerationScore(m15) {
  const period = 14;
  if (m15.length < period + 9) return { score: 0, acceleration: 0, v1: 0, v2: 0 };
  const a = atr(m15, period);
  if (!a || a === 0) return { score: 0, acceleration: 0, v1: 0, v2: 0 };
  const c0 = m15[m15.length - 1].close;
  const c4 = m15[m15.length - 5].close;
  const c8 = m15[m15.length - 9].close;
  const v1 = Math.abs(c0 - c4) / a;
  const v2 = Math.abs(c4 - c8) / a;
  const accel = v1 - v2;
  // Cap raw acceleration at 1.5 ATR — same reasoning as velocity: violent
  // spikes shouldn't out-score steady continuations. Saturates at 100.
  const score = Math.min(Math.max(accel, 0), 1.5) * (100 / 1.5);
  return {
    score: Math.round(score * 10) / 10,
    acceleration: Math.round(accel * 100) / 100,
    v1: Math.round(v1 * 100) / 100,
    v2: Math.round(v2 * 100) / 100,
  };
}

function compressionScore(m15) {
  if (m15.length < 51) return { score: 0, ratio: 0 };
  const a14 = atr(m15, 14);
  const a50 = atr(m15, 50);
  if (!a14 || !a50 || a50 === 0) return { score: 0, ratio: 0 };
  const ratio = a14 / a50;
  // Compression only ADDs when short-term ATR sits below the long-term band.
  // Expansion (ratio > 1.20) is neutral — during a strong H1 trend the M15
  // ATR routinely exceeds its 50-bar reading and that's continuation fuel,
  // not exhaustion. Don't penalise it.
  let score = 60;
  if (ratio < 0.70) score = 100;
  else if (ratio <= 0.85) score = 80;
  else score = 60;
  return { score, ratio: Math.round(ratio * 100) / 100 };
}

function candleControlScore(h1) {
  if (h1.length < 1) return { score: 0, efficiency: 0, source: 'H1' };
  const c = h1[h1.length - 1];
  const range = c.high - c.low;
  if (range <= 0) return { score: 0, efficiency: 0, source: 'H1' };
  const eff = Math.abs(c.close - c.open) / range;
  return {
    score: Math.round(eff * 100 * 10) / 10,
    efficiency: Math.round(eff * 100) / 100,
    source: 'H1',
  };
}

// Previous-UTC-day high/low from the H1 series. Used as a structural gate:
// a BUY needs the anchor close to have broken above yesterday's high; a SELL
// needs a close below yesterday's low. Guards against qualifying inside a
// range on the daily timeframe.
function previousDayRange(h1, anchorMs) {
  if (!h1 || !h1.length) return null;
  const d = new Date(anchorMs);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const yStart = todayStart - 24 * 3600000;
  const yEnd   = todayStart;
  let hi = -Infinity, lo = Infinity, count = 0;
  for (const c of h1) {
    const t = c._ms != null ? c._ms : new Date(c.time).getTime();
    if (t >= yStart && t < yEnd) {
      if (c.high > hi) hi = c.high;
      if (c.low  < lo) lo = c.low;
      count++;
    }
  }
  if (!count) return null;
  return { high: hi, low: lo, count, start: yStart, end: yEnd };
}

function analysePair(inst, h1, m15, opts) {
  const h1Bias = h1BiasScore(h1, opts);
  const h1Mom  = h1MomentumScore(h1);
  const m15V   = m15VelocityScore(m15);
  const m15A   = m15AccelerationScore(m15);
  const comp   = compressionScore(m15);
  const cand   = candleControlScore(h1);

  // Previous-day range break — H1 close for the H1 variant, M15 close for the
  // M15 variant so the "specific candle" that just closed is the one carrying
  // the break signal.
  const useM15 = opts && opts.dayBreakSource === 'M15';
  const triggerClose = useM15
    ? (m15.length ? m15[m15.length - 1].close : null)
    : (h1.length  ? h1[h1.length - 1].close   : null);
  const anchorMs = m15.length
    ? (m15[m15.length - 1]._ms || new Date(m15[m15.length - 1].time).getTime())
    : Date.now();
  const prevDay = previousDayRange(h1, anchorMs);
  let dayBreak = false;
  if (prevDay && triggerClose != null) {
    if (h1Bias.direction === 'BUY')  dayBreak = triggerClose > prevDay.high;
    if (h1Bias.direction === 'SELL') dayBreak = triggerClose < prevDay.low;
  }

  // Final composite score: 30% H1 bias + 20% M15 velocity + 20% M15 accel
  // + 30% candle control. Compression removed — it earns its keep on
  // breakout setups but noise-penalises established trends (ATR14/ATR50
  // ratio > 1 when a trend is running, which drags the score down for no
  // reason). The 10 % it used to hold was reallocated to Candle Control.
  const finalScore = Math.round(
    h1Bias.score  * 0.30 +
    m15V.score    * 0.20 +
    m15A.score    * 0.20 +
    cand.score    * 0.30
  );

  // Direction alignment gate — M15 recent 4-candle move must agree with H1 bias.
  const m15SignedAligned =
    (h1Bias.direction === 'BUY'  && m15V.signed > 0) ||
    (h1Bias.direction === 'SELL' && m15V.signed < 0);

  const rules = {
    h1Bias:        h1Bias.direction != null,
    m15Aligned:    m15SignedAligned,
    // With the new accel cap (saturates at 1.5), a score of 40 is ~0.6 ATR of
    // acceleration — enough to confirm a live move without demanding a spike.
    accelAbove40:  m15A.score > 40,
    velocityAbove55: m15V.score > 55,
    finalAbove75:  finalScore >= 75,
    dayBreak,
  };
  const qualifies = Object.values(rules).every(Boolean);

  return {
    pair: inst.replace('_', '/'),
    instrument: inst,
    direction: h1Bias.direction,
    finalScore,
    qualifies,
    components: {
      h1Bias, h1Momentum: h1Mom,
      m15Velocity: m15V, m15Acceleration: m15A,
      compression: comp, candleControl: cand,
    },
    rules,
    price: {
      h1Close: h1Bias.closePx,
      m15Close: m15.length ? m15[m15.length - 1].close : null,
      m15Time:  m15.length ? m15[m15.length - 1].time  : null,
      prevDayHigh: prevDay ? prevDay.high : null,
      prevDayLow:  prevDay ? prevDay.low  : null,
      dayBreakSource: useM15 ? 'M15' : 'H1',
      dayBreakClose: triggerClose,
    },
    pipDiv: pipDiv(inst),
  };
}

// ── Data fetch ─────────────────────────────────────────────────────────────
// Paginates so we can pull a full trading week of M15s without silently
// dropping rows to a limit cap. Weekends are gaps in the data; we just take
// whatever rows exist and let the indicators walk across the gap.
// Only complete candles are returned — a currently-forming H1 would carry a
// partial close price and break the breakout / EMA-alignment gates.
async function fetchCandles(sb, inst, tf, since, until) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close, volume')
      .eq('instrument', inst).eq('timeframe', tf).eq('complete', true)
      .gte('time', since).lte('time', until)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.map(c => ({
      time: c.time,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low:  parseFloat(c.low),
      close: parseFloat(c.close),
      volume: c.volume == null ? 0 : Number(c.volume),
    })));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb = getClient();
    if (!req._internal) {
      const gate = await requirePlan(sb, req, 'premium');
      if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });
    }

    const now = new Date();
    // Optional anchor: ?date=YYYY-MM-DD&time=HH:MM
    const qDate = req.query?.date;
    const qTime = req.query?.time;
    let anchor = null;
    if (qDate) {
      const t = qTime || '23:45';
      const parsed = new Date(qDate + 'T' + t + ':00Z');
      if (!isNaN(parsed.getTime())) {
        // snap to previous M15 boundary
        const ms = Math.floor(parsed.getTime() / (15 * 60000)) * (15 * 60000);
        anchor = new Date(ms);
      }
    }
    const untilTs = anchor ? anchor.toISOString() : now.toISOString();
    // Trading days are Mon-Fri. Weekend leaves a ~48h gap in candle data, so
    // early Monday runs need to reach back to Friday (and ideally Thursday) to
    // gather the 51 H1 / 51 M15 needed for EMA50 + ATR50. Fetch a wide window
    // and let pagination pull everything.
    const m15Since = new Date(new Date(untilTs).getTime() - 8  * 24 * 3600000).toISOString();
    const h1Since  = new Date(new Date(untilTs).getTime() - 12 * 24 * 3600000).toISOString();

    // Which timeframe drives the currency-strength gate. Default H1, override
    // via ?strengthTf=m15 for the M15 variant page.
    const strengthTf = (req.query?.strengthTf === 'm15') ? 'M15' : 'H1';

    const rows = [];
    const pairH1 = {};
    const pairM15 = {};
    let skippedInsufficient = 0;
    let maxH1Seen = 0;
    let maxM15Seen = 0;
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const [h1, m15] = await Promise.all([
          fetchCandles(sb, inst, 'H1',  h1Since,  untilTs),
          fetchCandles(sb, inst, 'M15', m15Since, untilTs),
        ]);
        if (h1.length > maxH1Seen) maxH1Seen = h1.length;
        if (m15.length > maxM15Seen) maxM15Seen = m15.length;
        if (h1.length < 51 || m15.length < 51) return null;
        pairH1[inst]  = h1;
        pairM15[inst] = m15;
        // In M15-strength mode we don't require a fresh H1 breakout — the M15
        // strength picture is what drives selection, and the H1 breakout gate
        // is too coarse for the faster timeframe's cadence.
        return analysePair(inst, h1, m15, {
          requireBreakout: strengthTf !== 'M15',
          dayBreakSource:  strengthTf === 'M15' ? 'M15' : 'H1',
        });
      }));
      for (const r of results) if (r == null) skippedInsufficient++; else rows.push(r);
    }

    // Per-currency strength — used to gate pair direction. For a BUY pair the
    // base currency must be strong AND the quote must be weak; SELL requires
    // the reverse. Prevents surfacing high-score pairs where the broader
    // currency context contradicts the direction. Same maths for H1 and M15;
    // only the candle series changes.
    const strength = computeCurrencyStrength(
      strengthTf === 'M15' ? pairM15 : pairH1,
      strengthTf,
    );

    // M15-strength page: only Layer 1 (EMA slope depth) + Layer 2 (price +
    // EMA20/EMA50 stack) gate selection. All other components are still
    // computed for display but do not gate qualification.
    if (strengthTf === 'M15') {
      const SLOPE_QUAL = 0.18; // mid-shallow or better (spec: 0.10 shallow, 0.30 strong)
      for (const r of rows) {
        const score = m15SlopeScore(pairM15[r.instrument]);
        if (score == null) {
          r.direction = null;
          r.qualifies = false;
          r.finalScore = 0;
          r.rules = { m15EmaStack: false, slopeDepthAbove30: false };
          r.m15SlopeScore = null;
          continue;
        }
        r.m15SlopeScore = score;
        if      (score >=  SLOPE_QUAL) r.direction = 'BUY';
        else if (score <= -SLOPE_QUAL) r.direction = 'SELL';
        else                            r.direction = null;
        // Both layers pass when |score| ≥ 0.30 — m15SlopeScore already returns
        // 0 when the EMA20/EMA50 stack disagrees with the slope, so a non-zero
        // score also implies the stack is aligned with direction.
        const stackAligned = score !== 0;
        const slopeStrong  = Math.abs(score) >= SLOPE_QUAL;
        r.rules = { m15EmaStack: stackAligned, slopeDepthAbove30: slopeStrong };
        r.finalScore = Math.round(Math.abs(score) * 100);
        r.qualifies  = stackAligned && slopeStrong;
      }
      // Currency-strength gate: base currency strong AND quote weak, plus one
      // extreme (|strength| = 1) — same rule the H1 variant uses, applied on
      // top of the two-layer EMA selector.
      const biased = rows.filter(r => r.direction != null);
      for (const r of biased) {
        const [base, quote] = r.instrument.split('_');
        r.currencyStrength = {
          base:  { code: base,  value: strength[base]  },
          quote: { code: quote, value: strength[quote] },
          aligned: strengthAligned(r.instrument, r.direction, strength, strengthTf),
        };
        r.qualifies = r.qualifies && r.currencyStrength.aligned;
        r.rules.strengthAligned = r.currencyStrength.aligned;
      }
      biased.sort((a, b) => b.finalScore - a.finalScore);
      const qualified = biased.filter(r => r.qualifies);
      const selected = qualified[0] || null;
      return res.json({
        generatedAt: untilTs,
        total: biased.length,
        analysed: rows.length,
        qualifiedCount: qualified.length,
        skippedInsufficient,
        skippedNeutralBias: rows.length - biased.length,
        warmup: { needH1: 51, needM15: 51, haveH1: maxH1Seen, haveM15: maxM15Seen },
        selected,
        results: biased,
        currencyStrength: strength,
        strengthTf,
      });
    }

    // Rank by final score descending; only surface pairs whose H1 bias is set
    // (Close > EMA20 > EMA50 for BUY, Close < EMA20 < EMA50 for SELL). Neutrals
    // disqualify by definition — hide them so the list stays actionable.
    const biased = rows.filter(r => r.direction != null);
    biased.sort((a, b) => b.finalScore - a.finalScore);

    // Annotate every biased row so the frontend can render the strength on the
    // detail modal even for pairs that failed the alignment gate.
    for (const r of biased) {
      const [base, quote] = r.instrument.split('_');
      r.currencyStrength = {
        base:  { code: base,  value: strength[base]  },
        quote: { code: quote, value: strength[quote] },
        aligned: strengthAligned(r.instrument, r.direction, strength, strengthTf),
      };
      // Fold the alignment gate into `qualifies` so the frontend's existing
      // colouring / selected-pair logic picks it up without further changes.
      r.qualifies = r.qualifies && r.currencyStrength.aligned;
      if (r.rules) r.rules.strengthAligned = r.currencyStrength.aligned;
    }

    const qualified = biased.filter(r => r.qualifies);
    const selected = qualified[0] || null;

    res.json({
      generatedAt: untilTs,
      total: biased.length,
      analysed: rows.length,
      qualifiedCount: qualified.length,
      skippedInsufficient,
      skippedNeutralBias: rows.length - biased.length,
      warmup: {
        needH1: 51,
        needM15: 51,
        haveH1: maxH1Seen,
        haveM15: maxM15Seen,
      },
      selected,
      results: biased,
      currencyStrength: strength,
      strengthTf,
    });
  } catch (e) {
    console.error('[acceleration-v4]', e);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;

// Expose helpers so /api/acceleration-v4-history can reuse them without
// invoking this handler N times.
module.exports.analysePair = analysePair;
module.exports.fetchCandles = fetchCandles;
module.exports.VALID_PAIRS = VALID_PAIRS;
module.exports.computeCurrencyStrength = computeCurrencyStrength;
module.exports.strengthAligned = strengthAligned;
module.exports.m15SlopeScore = m15SlopeScore;
module.exports.STRENGTH_STRONG = STRENGTH_STRONG;
module.exports.STRENGTH_WEAK = STRENGTH_WEAK;
