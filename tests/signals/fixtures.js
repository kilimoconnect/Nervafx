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

module.exports = { genBase, GROWTH_UNITS, scaledGrowth, PAIRS, CURRENCIES, TF_MS };
