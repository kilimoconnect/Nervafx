'use strict';

/**
 * Build synchronized relative currency INDICES from M15 pair candles (see config.js).
 * Deterministic. Uses a common observation timeline = the M15 close times where ALL
 * 28 pairs are present, so the basket composition never silently changes. Returns are
 * log returns; indices accumulate from the common base value. Weekend/holiday gaps are
 * recorded, never filled with artificial flat candles.
 */

const { M15_MS, CURRENCIES, PAIRS, legsFor, BASE_VALUE } = require('./config');

function buildIndices(candlesByPair, opts) {
  const base = (opts && opts.baseValue) || BASE_VALUE;
  const baseMs = (opts && opts.baseMs) || M15_MS;   // candle interval of the inputs (M15 or H1)
  // close-time → { pair: close } ; keep only times present for ALL pairs.
  const byTime = new Map();
  for (const p of PAIRS) {
    const cs = (candlesByPair[p] || []);
    for (const c of cs) { const t = (c.openMs != null ? c.openMs : Date.parse(c.time)) + baseMs; let m = byTime.get(t); if (!m) { m = {}; byTime.set(t, m); } m[p] = +c.close; }
  }
  const timeline = [];
  for (const [t, m] of byTime) { let ok = true; for (const p of PAIRS) { if (m[p] == null) { ok = false; break; } } if (ok) timeline.push(t); }
  timeline.sort((a, b) => a - b);
  if (timeline.length < 2) return { ok: false, reason: 'insufficient synchronized observations' };

  // precompute legs per currency
  const legs = {}; for (const c of CURRENCIES) legs[c] = legsFor(c);
  const index = {}; for (const c of CURRENCIES) index[c] = new Array(timeline.length);
  for (const c of CURRENCIES) index[c][0] = base;

  const closeOf = (t) => { const m = byTime.get(t); return m; };
  for (let i = 1; i < timeline.length; i++) {
    const t = timeline[i], tp = timeline[i - 1], m = closeOf(t), mp = closeOf(tp);
    // per-pair log return at this step
    const pr = {}; for (const p of PAIRS) pr[p] = Math.log(m[p] / mp[p]);
    for (const c of CURRENCIES) {
      let s = 0; for (const leg of legs[c]) s += leg.sign * pr[leg.pair];
      const rc = s / 8;   // eight-currency zero-sum normalization
      index[c][i] = index[c][i - 1] * Math.exp(rc);
    }
  }

  // gaps: consecutive timeline steps longer than 1 base interval (scheduled closure vs missing).
  const gaps = [];
  for (let i = 1; i < timeline.length; i++) { const d = timeline[i] - timeline[i - 1]; if (d > baseMs) gaps.push({ fromMs: timeline[i - 1], toMs: timeline[i], ms: d }); }

  const resolution = baseMs === M15_MS ? 'M15' : (baseMs === 3600000 ? 'H1' : 'custom');
  return { ok: true, timeline, index, firstMs: timeline[0], lastMs: timeline[timeline.length - 1], resolution, baseMs, nSteps: timeline.length, gaps, baseValue: base };
}

/** Index value for a currency at the last timeline point ≤ t (carry at a boundary). */
function idxAtOrBefore(built, ccy, t) {
  const tl = built.timeline; let lo = 0, hi = tl.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (tl[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans < 0 ? null : { idx: ans, ms: tl[ans], value: built.index[ccy][ans] };
}

module.exports = { buildIndices, idxAtOrBefore };
