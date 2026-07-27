'use strict';

/**
 * GET /api/currency-strength-m15-45m
 *
 * Currency-strength EVOLUTION on the M15 timeframe using a 45-minute (3-candle)
 * lookback, sampled every 15 minutes. Same movement-based maths as the hourly
 * currency_strength pipeline (src/strength.js), only the timeframe and window
 * change:
 *
 *   movement(pair) = (close_now - close_45m_ago) / close_45m_ago
 *   strength(base)  += movement ; strength(quote) -= movement   (over 28 pairs)
 *   normalized       = strength / 7                              (pairs per ccy)
 *
 * The per-currency value is a COMPOSITE conviction score (signed, ±100): the
 * sign is the 45m movement direction, the magnitude is a weighted blend of six
 * layers — movement 30%, persistence 20%, acceleration 15%, breadth 15%, trend
 * quality 10%, session quality 10%. The underlying 45m return is still returned
 * as `raw`, and each step carries a per-currency `layers` breakdown.
 *
 * Live view (no ?date) returns the last ~24h of M15 steps; ?date=YYYY-MM-DD
 * returns that whole UTC day.
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
const PAIRS_PER_CCY = 7;
const M15_MS = 15 * 60 * 1000;
const LOOKBACK_MS = 45 * 60 * 1000; // 45 minutes = 3 M15 candles

// ── Composite conviction config ─────────────────────────────────────────────
// One signed score per currency: sign = 45m movement direction, magnitude =
// weighted blend of six layers (each 0-100, acceleration ±100).
const WEIGHTS = { movement: 0.30, persistence: 0.20, accel: 0.15, breadth: 0.15, trend: 0.10, session: 0.10 };
const WARMUP_STEPS   = 8;   // extra history steps so the first shown step has layers
const MOVEMENT_CAP   = 12;  // |45m score| that reads as full movement (100)
const PERSIST_WINDOW = 5;   // steps looked back for persistence
const ACCEL_CAP      = 6;   // score-change that reads as full acceleration
const TREND_WINDOW   = 6;   // steps for the trend-quality (smoothness) proxy

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Session quality by UTC hour: London > New York > Asia / off-hours.
function sessionWeight(hourUTC) {
  if (hourUTC >= 6 && hourUTC < 12) return 100; // London
  if (hourUTC >= 12 && hourUTC < 21) return 90; // New York
  return 60;                                     // Asia / off-hours
}

// Persistence: share of the last N steps that held the current sign with a
// meaningful magnitude (a currency that stays strong scores high).
function persistenceScore(series, i, sign) {
  let match = 0, n = 0;
  for (let k = Math.max(0, i - PERSIST_WINDOW + 1); k <= i; k++) {
    n++;
    if (Math.sign(series[k]) === sign && Math.abs(series[k]) >= 2) match++;
  }
  return n ? (match / n) * 100 : 0;
}

// Acceleration: change in strength in the move's direction — positive when
// gaining power, negative when fading. Scaled and clamped to ±100.
function accelScore(series, i, sign) {
  if (i < 1) return 0;
  return clamp(((series[i] - series[i - 1]) * sign / ACCEL_CAP) * 100, -100, 100);
}

// Trend quality proxy: directional efficiency of the strength curve — a smooth
// one-way move scores high, a choppy back-and-forth scores low.
function trendQualityScore(series, i) {
  const start = Math.max(0, i - TREND_WINDOW + 1);
  if (i - start < 2) return 50; // too little history → neutral
  const net = Math.abs(series[i] - series[start]);
  let path = 0;
  for (let k = start + 1; k <= i; k++) path += Math.abs(series[k] - series[k - 1]);
  return path > 0 ? Math.min(100, (net / path) * 100) : 0;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sb = getClient();
  try {
    const now = Date.now();

    // Window: a specific UTC day, else the last 24h (live).
    const qDate = req.query?.date;
    let startMs, endMs;
    if (qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate)) {
      const day = new Date(qDate + 'T00:00:00Z').getTime();
      startMs = day;
      endMs = Math.min(day + 24 * 60 * 60 * 1000, now);
    } else {
      endMs = now;
      startMs = now - 24 * 60 * 60 * 1000;
    }
    // Fetch far enough back that the warm-up steps (for persistence/accel/trend)
    // each still have their own 45m lookback.
    const computeStartMs = startMs - WARMUP_STEPS * M15_MS;
    const fetchSince = new Date(computeStartMs - LOOKBACK_MS - M15_MS).toISOString();
    const fetchUntil = new Date(endMs).toISOString();

    // close-by-instrument, keyed by ISO time.
    const PAGE = 1000;
    const closes = {}; // inst -> { isoTime: close }
    for (let b = 0; b < PAIRS.length; b += 7) {
      const batch = PAIRS.slice(b, b + 7);
      const results = await Promise.all(batch.map(async inst => {
        const rows = [];
        let off = 0;
        while (true) {
          const { data, error } = await sb
            .from('backtest_candles')
            .select('time, close')
            .eq('instrument', inst).eq('timeframe', 'M15').eq('complete', true)
            .gte('time', fetchSince).lte('time', fetchUntil)
            .order('time', { ascending: true })
            .range(off, off + PAGE - 1);
          if (error) throw error;
          if (!data || !data.length) break;
          rows.push(...data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return { inst, rows };
      }));
      for (const { inst, rows } of results) {
        const map = {};
        for (const r of rows) map[new Date(r.time).getTime()] = parseFloat(r.close);
        closes[inst] = map;
      }
    }

    // ── Pass 1: raw 45m strength (+ per-currency breadth) per M15 step, over
    // the extended warm-up window.
    const rawSteps = [];
    const firstStep = Math.ceil(computeStartMs / M15_MS) * M15_MS;
    for (let t = firstStep; t <= endMs; t += M15_MS) {
      const past = t - LOOKBACK_MS;
      const raw = Object.fromEntries(CCYS.map(c => [c, 0]));
      const moves = {};
      let complete = true;

      for (const inst of PAIRS) {
        const nowClose = closes[inst]?.[t];
        const pastClose = closes[inst]?.[past];
        if (nowClose === undefined || pastClose === undefined) { complete = false; break; }
        const [base, quote] = inst.split('_');
        const mv = (nowClose - pastClose) / pastClose;
        moves[inst] = mv;
        raw[base] += mv;
        raw[quote] -= mv;
      }
      if (!complete) continue; // skip steps missing any pair's 45m window

      const score = {};
      for (const c of CCYS) score[c] = +((raw[c] / PAIRS_PER_CCY) * 10000).toFixed(2);

      // Breadth (Layer 4): of a currency's 7 pairs, how many moved in its net
      // direction over the 45m window.
      const breadth = {};
      for (const c of CCYS) {
        const positive = score[c] >= 0;
        let agree = 0;
        for (const inst of PAIRS) {
          const [base, quote] = inst.split('_');
          if (base !== c && quote !== c) continue;
          const cGained = base === c ? moves[inst] > 0 : moves[inst] < 0;
          if (cGained === positive) agree++;
        }
        breadth[c] = (agree / PAIRS_PER_CCY) * 100;
      }

      rawSteps.push({ t, score, breadth, hour: new Date(t).getUTCHours() });
    }

    // Per-currency raw-score series, index-aligned with rawSteps.
    const series = Object.fromEntries(CCYS.map(c => [c, rawSteps.map(s => s.score[c])]));

    // ── Pass 2: composite conviction per currency; output only in-window steps.
    const steps = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const rs = rawSteps[i];
      if (rs.t < startMs) continue; // warm-up only

      const conviction = {}; // signed ±100
      const raw45 = {};      // underlying 45m return score
      const layers = {};     // component breakdown (for tooltip/debug)
      for (const c of CCYS) {
        const sc = rs.score[c];
        raw45[c] = +sc.toFixed(1);
        const sign = Math.sign(sc) || 0;
        const movement = Math.min(100, Math.abs(sc) / MOVEMENT_CAP * 100);
        const persistence = persistenceScore(series[c], i, sign);
        const accel = accelScore(series[c], i, sign);
        const breadth = rs.breadth[c];
        const trend = trendQualityScore(series[c], i);
        const session = sessionWeight(rs.hour);
        const mag = clamp(
          WEIGHTS.movement * movement + WEIGHTS.persistence * persistence +
          WEIGHTS.accel * accel + WEIGHTS.breadth * breadth +
          WEIGHTS.trend * trend + WEIGHTS.session * session, 0, 100);
        conviction[c] = +(sign * mag).toFixed(1);
        layers[c] = {
          movement: +movement.toFixed(0), persistence: +persistence.toFixed(0),
          accel: +accel.toFixed(0), breadth: +breadth.toFixed(0),
          trend: +trend.toFixed(0), session,
        };
      }

      const ranked = CCYS.map(c => ({ currency: c, value: conviction[c], score: conviction[c] }))
        .sort((a, b) => b.value - a.value);
      const topAbs = Math.abs(ranked[0].score);
      const botAbs = Math.abs(ranked[ranked.length - 1].score);
      const hi = Math.max(topAbs, botAbs);
      const lo = Math.min(topAbs, botAbs);

      // Top trade pairs by conviction spread (base − quote).
      const topPairs = PAIRS.map(inst => {
        const [base, quote] = inst.split('_');
        const sp = conviction[base] - conviction[quote];
        return {
          pair: inst.replace('_', '/'),
          direction: sp >= 0 ? 'BUY' : 'SELL',
          spread: +Math.abs(sp).toFixed(1),
        };
      }).sort((a, b) => b.spread - a.spread).slice(0, 3);

      steps.push({
        time: new Date(rs.t).toISOString(),
        // The M15 candle at t closes at t+15m — that's when this reading exists.
        signalTime: new Date(rs.t + M15_MS).toISOString(),
        strength: conviction, // composite conviction (signed, ±100)
        score: conviction,    // alias the page renders
        raw: raw45,           // underlying 45m return
        layers,
        strongest: ranked[0],
        weakest: ranked[ranked.length - 1],
        gapRatio: lo >= 0.05 ? +(hi / lo).toFixed(2) : null,
        gapHi: +hi.toFixed(1),
        gapLo: +lo.toFixed(1),
        topPairs,
      });
    }

    res.json({
      window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
      lookbackMinutes: 45,
      composite: true,
      weights: WEIGHTS,
      currencies: CCYS,
      steps,
    });
  } catch (e) {
    console.error('[m15-strength-45m]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
