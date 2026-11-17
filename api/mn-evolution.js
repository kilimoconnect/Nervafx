'use strict';

/**
 * GET /api/mn-evolution — Month-so-far % evolution on H4 candles (research, UNVALIDATED).
 *
 * Same engine as /api/currency-evolution, but the developing period is the current EAT calendar
 * month (1st 00:00 EAT) and the zero-sum 1/8 index is built from H4 candles. H4 is not stored, so
 * it is rolled up from H1 with EAT-aligned buckets (00/04/08/12/16/20 EAT) — UTC-floored H4 would
 * miss the 00:00 EAT month open by an hour. Returns the open-relative % path for all 8 currency
 * indices through the latest completed H4 of the developing month, the dispersion "watch" windows,
 * and a historical scan over past EAT months (months are variable length, so the scan steps by the
 * first-of-next-month, not a fixed stride).
 *
 *   ?asOf=<ms|ISO>   causal replay (no look-ahead; defaults to live)
 *   ?days=<n>        history window to load/scan in days (default 365 ≈ 12 months, cap 550)
 *   ?threshold=<p>   best-movement % threshold (default 0.20)
 *   ?spread=<p>      dispersion (strongest−weakest) gate % (default 0.25)
 *
 * Relative-movement research only — NO execution, buy/sell signal, probability, or profitability.
 */

const { getClient, cors } = require('./_db');
const { loadH1Parallel } = require('../research/comparison/dbload');
const { aggregatePairsH4Eat } = require('../research/comparison/aggregate');
const { buildIndices } = require('../research/comparison/index-build');
const { liveEvolution, historyScan } = require('../research/comparison/evolution');
const { monthStart } = require('../research/comparison/periods');
const { CONFIG, PAIRS, H4_MS, DAY_MS } = require('../research/comparison/config');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
// Variable-length months: start → the 1st 00:00 EAT; next → the first-of-next-month (probe mid-month
// forward then snap back to its month start). step is a nominal fallback (unused while next is set).
const PERIOD = { start: monthStart, step: 30 * DAY_MS, next: (ms) => monthStart(ms + 32 * DAY_MS) };

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};
    let asOfMs = Date.now(), mode = 'live';
    if (q.asOf != null && q.asOf !== '') {
      const t = /^\d+$/.test('' + q.asOf) ? parseInt(q.asOf, 10) : Date.parse(q.asOf);
      if (!isNaN(t) && t < Date.now()) { asOfMs = t; mode = 'historical'; }
    }
    const days = Math.min(550, Math.max(31, parseInt(q.days, 10) || 365));   // H1 → H4 over ~12 months
    const threshold = Math.min(5, Math.max(0.01, parseFloat(q.threshold) || 0.20));
    const spreadThreshold = Math.min(10, Math.max(0.01, parseFloat(q.spread) || 0.25));

    const sb = getClient();
    const fromIso = new Date(asOfMs - days * DAY_MS).toISOString();
    const opts = { fromIso }; if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
    const byH1 = await loadH1Parallel(sb, PAIRS, opts, 8);
    const byH4 = {}; for (const p of PAIRS) byH4[p] = aggregatePairsH4Eat(byH1[p] || []);

    const built = buildIndices(byH4, { baseMs: H4_MS });
    if (!built.ok) return res.json({ ok: true, available: false, mode, reason: built.reason });

    const live = liveEvolution(built, asOfMs, built.lastMs, threshold, spreadThreshold, PERIOD);
    const history = historyScan(built, asOfMs, built.lastMs, { threshold, spreadThreshold, period: PERIOD, matrixDays: 18 });

    res.json({
      ok: true, available: true, mode, version: CONFIG.version, threshold, spreadThreshold,
      asOfUtc: iso(asOfMs), firstDataUtc: iso(built.firstMs), lastDataUtc: iso(built.lastMs),
      resolution: built.resolution, windowDays: days,
      meta: { periodName: 'Month so far', periodWord: 'month', openLabel: '1st 00:00 EAT month open', resolution: 'H4', historyUnit: 'EAT months', subDay: false },
      live, history,
      disclaimer: 'Relative-movement research (zero-sum 1/8 index on H4, aggregated EAT-aligned from H1), UNVALIDATED. Not a signal, probability, or profitability claim; no orders.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
