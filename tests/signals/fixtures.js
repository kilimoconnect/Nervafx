'use strict';

/**
 * Deterministic synthetic candles for the signal tests. A self-consistent currency
 * "value network": each currency c has a log-growth g_c per step; pair price = V_base/V_quote.
 * Then a currency's period index return telescopes to N·(g_c − mean_g), so the pair
 * differential A/B = N·(g_A − g_B) — ranking depends only on the g differences. This lets
 * tests assert exact top-3 ordering and tie handling.
 */

const { PAIRS, CURRENCIES, TF_MS } = require('../../research/signals/config');

/** Build synchronized base candles for all 28 pairs from per-currency log-growths. */
function genBase(growth, startMs, n, baseMs, shaper) {
  const out = {}; for (const p of PAIRS) out[p] = [];
  for (let i = 0; i < n; i++) {
    const t = startMs + i * baseMs;
    const val = {}; for (const c of CURRENCIES) val[c] = Math.exp((growth[c] || 0) * i);
    for (const p of PAIRS) {
      const [b, q] = p.split('_');
      const px = val[b] / val[q];
      let candle = { openMs: t, open: px, high: px, low: px, close: px, volume: 100 };
      if (shaper) candle = shaper(p, i, candle, t);
      out[p].push(candle);
    }
  }
  return out;
}

// A spread of growth rates (× k per step). Extremes: AUD (+3), JPY (−3).
const GROWTH_UNITS = { USD: 0, EUR: 1, GBP: 2, JPY: -3, CHF: -1, CAD: 0.5, AUD: 3, NZD: -2 };
function scaledGrowth(k) { const g = {}; for (const c of CURRENCIES) g[c] = GROWTH_UNITS[c] * k; return g; }

/**
 * A dataset engineered so the `today` strategy fires EXACTLY ONE signal: AUD_JPY BUY that
 * closes at target. All pair CLOSES stay on the clean index path (so selection + confirmation
 * work), while only AUD_JPY's intrabar OHLC is shaped to form the 3-candle BUY trigger and a
 * wide range (ATR >> per-step move, so the entry is not spuriously cancelled).
 * Returns { baseByPair, monByPair, lastDataMs }.
 */
function genFiring({ n = 400, K = 300, k = 0.0003, w = 0.006 } = {}) {
  const start = Date.UTC(2025, 4, 1, 0, 0, 0);
  const g = scaledGrowth(k);
  const base = {}; for (const p of PAIRS) base[p] = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * TF_MS.M15;
    const val = {}; for (const c of CURRENCIES) val[c] = Math.exp(g[c] * i);
    for (const p of PAIRS) {
      const [b, q] = p.split('_');
      const c = val[b] / val[q];
      let candle = { openMs: t, open: c, high: c, low: c, close: c, volume: 100 };
      if (p === 'AUD_JPY') {
        if (i === K)          candle = { openMs: t, open: c * 1.003,  high: c * (1 + w), low: c * (1 - w), close: c, volume: 100 };
        else if (i === K + 1) candle = { openMs: t, open: c * 1.0015, high: c * 1.0015,  low: c * (1 - w), close: c, volume: 100 };
        else if (i === K + 2) candle = { openMs: t, open: c * 0.997,  high: c * (1 + w), low: c * 0.997,   close: c, volume: 100 };
        else                  candle = { openMs: t, open: c, high: c * (1 + w), low: c * (1 - w), close: c, volume: 100 };
      }
      base[p].push(candle);
    }
  }
  const mon = {}; for (const p of PAIRS) mon[p] = { m5: [], m15: base[p].map((r) => ({ openMs: r.openMs, open: r.open, high: r.high, low: r.low, close: r.close })) };
  return { baseByPair: base, monByPair: mon, lastDataMs: start + n * TF_MS.M15 };
}

module.exports = { genBase, genFiring, GROWTH_UNITS, scaledGrowth, PAIRS, CURRENCIES, TF_MS };
