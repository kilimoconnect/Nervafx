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
 * Live view (no ?date) returns the last ~24h of M15 steps; ?date=YYYY-MM-DD
 * returns that whole UTC day. Values are returned normalized (small fractions)
 * plus a x10000 "score" for display.
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
    // Fetch 45m before the window so the first steps have their lookback.
    const fetchSince = new Date(startMs - LOOKBACK_MS - M15_MS).toISOString();
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

    // Step through every M15 boundary in the window.
    const steps = [];
    const firstStep = Math.ceil(startMs / M15_MS) * M15_MS;
    for (let t = firstStep; t <= endMs; t += M15_MS) {
      const past = t - LOOKBACK_MS;
      const strength = Object.fromEntries(CCYS.map(c => [c, 0]));
      let complete = true;

      for (const inst of PAIRS) {
        const nowClose = closes[inst]?.[t];
        const pastClose = closes[inst]?.[past];
        if (nowClose === undefined || pastClose === undefined) { complete = false; break; }
        const [base, quote] = inst.split('_');
        const movement = (nowClose - pastClose) / pastClose;
        strength[base] += movement;
        strength[quote] -= movement;
      }
      if (!complete) continue; // skip steps missing any pair's 45m window

      const norm = {};
      const score = {};
      for (const c of CCYS) {
        norm[c] = strength[c] / PAIRS_PER_CCY;
        score[c] = +(norm[c] * 10000).toFixed(1);
      }
      const ranked = CCYS.map(c => ({ currency: c, value: norm[c], score: score[c] }))
        .sort((a, b) => b.value - a.value);

      // Gap ratio between the extremes (1st vs 8th): larger magnitude over the
      // smaller, e.g. 1st +7.5 & 8th -2.5 -> 7.5/2.5 = 3.0. A high ratio means
      // the strength is concentrated on one side rather than evenly split.
      const topAbs = Math.abs(ranked[0].score);
      const botAbs = Math.abs(ranked[ranked.length - 1].score);
      const hi = Math.max(topAbs, botAbs);
      const lo = Math.min(topAbs, botAbs);

      // Top trade pairs by strength spread (base − quote). Direction buys the
      // stronger leg. Most useful on lopsided (high-gap) steps.
      const topPairs = PAIRS.map(inst => {
        const [base, quote] = inst.split('_');
        const sp = norm[base] - norm[quote];
        return {
          pair: inst.replace('_', '/'),
          direction: sp >= 0 ? 'BUY' : 'SELL',
          spread: +(Math.abs(sp) * 10000).toFixed(1),
        };
      }).sort((a, b) => b.spread - a.spread).slice(0, 3);

      steps.push({
        time: new Date(t).toISOString(),
        strength: norm,
        score,
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
      currencies: CCYS,
      steps,
    });
  } catch (e) {
    console.error('[m15-strength-45m]', e.message);
    res.status(500).json({ error: e.message });
  }
};

module.exports.maxDuration = 60;
