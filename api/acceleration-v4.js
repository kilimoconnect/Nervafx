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
function h1BiasScore(h1) {
  if (h1.length < 51) return { direction: null, score: 0, closePx: null, ema20: null, ema50: null };
  const closes = h1.map(c => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const closePx = closes[closes.length - 1];
  if (e20 == null || e50 == null) return { direction: null, score: 0, closePx, ema20: e20, ema50: e50 };

  let direction = null;
  let score = 0;
  if (closePx > e20 && e20 > e50)      { direction = 'BUY';  score = 100; }
  else if (closePx < e20 && e20 < e50) { direction = 'SELL'; score = 100; }
  return { direction, score, closePx, ema20: e20, ema50: e50 };
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
  const score = Math.min(v * 33, 100);
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
  const score = Math.min(Math.max(accel * 50, 0), 100);
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
  let score = 30;
  if (ratio < 0.70) score = 100;
  else if (ratio <= 0.85) score = 70;
  return { score, ratio: Math.round(ratio * 100) / 100 };
}

function candleControlScore(m15) {
  if (m15.length < 1) return { score: 0, efficiency: 0 };
  const c = m15[m15.length - 1];
  const range = c.high - c.low;
  if (range <= 0) return { score: 0, efficiency: 0 };
  const eff = Math.abs(c.close - c.open) / range;
  return { score: Math.round(eff * 100 * 10) / 10, efficiency: Math.round(eff * 100) / 100 };
}

function volumeExpansionScore(m15) {
  if (m15.length < 21) return { score: 0, ratio: 0 };
  const currentVol = m15[m15.length - 1].volume || 0;
  const window = m15.slice(-21, -1);
  const avgVol = window.reduce((s, c) => s + (c.volume || 0), 0) / window.length;
  if (!avgVol) return { score: 0, ratio: 0 };
  const ratio = currentVol / avgVol;
  const score = Math.min(ratio * 50, 100);
  return { score: Math.round(score * 10) / 10, ratio: Math.round(ratio * 100) / 100 };
}

function analysePair(inst, h1, m15) {
  const h1Bias = h1BiasScore(h1);
  const h1Mom  = h1MomentumScore(h1);
  const m15V   = m15VelocityScore(m15);
  const m15A   = m15AccelerationScore(m15);
  const comp   = compressionScore(m15);
  const cand   = candleControlScore(m15);
  const vol    = volumeExpansionScore(m15);

  // Final composite score: 30% H1 bias + 20% M15 velocity + 30% M15 accel + 10% compression + 10% candle.
  const finalScore = Math.round(
    h1Bias.score  * 0.30 +
    m15V.score    * 0.20 +
    m15A.score    * 0.30 +
    comp.score    * 0.10 +
    cand.score    * 0.10
  );

  // Direction alignment gate — M15 recent 4-candle move must agree with H1 bias.
  const m15SignedAligned =
    (h1Bias.direction === 'BUY'  && m15V.signed > 0) ||
    (h1Bias.direction === 'SELL' && m15V.signed < 0);

  const rules = {
    h1Bias:        h1Bias.direction != null,
    m15Aligned:    m15SignedAligned,
    accelAbove70:  m15A.score > 70,
    velocityAbove60: m15V.score > 60,
    finalAbove85:  finalScore > 85,
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
      compression: comp, candleControl: cand, volume: vol,
    },
    rules,
    price: {
      h1Close: h1Bias.closePx,
      m15Close: m15.length ? m15[m15.length - 1].close : null,
      m15Time:  m15.length ? m15[m15.length - 1].time  : null,
    },
    pipDiv: pipDiv(inst),
  };
}

// ── Data fetch ─────────────────────────────────────────────────────────────
async function fetchCandles(sb, inst, tf, since, until, limit) {
  const { data, error } = await sb
    .from('backtest_candles')
    .select('time, open, high, low, close, volume')
    .eq('instrument', inst).eq('timeframe', tf)
    .gte('time', since).lte('time', until)
    .order('time', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(c => ({
    time: c.time,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: c.volume == null ? 0 : Number(c.volume),
  }));
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
    // Enough history: 60 * 15m ≈ 15h for M15, 55 * 1h ≈ 55h for H1
    const m15Since = new Date(new Date(untilTs).getTime() - 20 * 60 * 60000).toISOString();
    const h1Since  = new Date(new Date(untilTs).getTime() - 80 * 60 * 60000).toISOString();

    const rows = [];
    for (let b = 0; b < VALID_PAIRS.length; b += 7) {
      const batch = VALID_PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const [h1, m15] = await Promise.all([
          fetchCandles(sb, inst, 'H1',  h1Since,  untilTs, 200),
          fetchCandles(sb, inst, 'M15', m15Since, untilTs, 200),
        ]);
        if (h1.length < 51 || m15.length < 51) return null;
        return analysePair(inst, h1, m15);
      }));
      for (const r of results) if (r) rows.push(r);
    }

    // Rank by final score descending
    rows.sort((a, b) => b.finalScore - a.finalScore);

    const qualified = rows.filter(r => r.qualifies);
    const selected = qualified[0] || null;

    res.json({
      generatedAt: untilTs,
      total: rows.length,
      qualifiedCount: qualified.length,
      selected,
      results: rows,
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
