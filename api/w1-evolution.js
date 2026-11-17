'use strict';

/**
 * GET /api/w1-evolution — Week-so-far % evolution on H1 candles (research, UNVALIDATED).
 *
 * Same engine as /api/currency-evolution, but the developing period is the current EAT trading
 * week (Monday 00:00 EAT) and the zero-sum 1/8 index is built from H1 candles (H1 boundaries land
 * exactly on 00:00 EAT, so the week open is a real index observation). Returns the open-relative %
 * path for all 8 currency indices through the latest completed H1 of the developing week, the
 * dispersion "watch" windows, and a historical scan over past EAT weeks.
 *
 *   ?asOf=<ms|ISO>   causal replay (no look-ahead; defaults to live)
 *   ?days=<n>        history window to load/scan in days (default 180 ≈ 26 weeks, cap 365)
 *   ?threshold=<p>   best-movement % threshold (default 0.20)
 *   ?spread=<p>      dispersion (strongest−weakest) gate % (default 0.25)
 *
 * Relative-movement research only — NO execution, buy/sell signal, probability, or profitability.
 */

const { getClient, cors } = require('./_db');
const { loadH1Parallel } = require('../research/comparison/dbload');
const { buildIndices } = require('../research/comparison/index-build');
const { liveEvolution, historyScan } = require('../research/comparison/evolution');
const { weekStart } = require('../research/comparison/periods');
const { CONFIG, PAIRS, H1_MS, DAY_MS } = require('../research/comparison/config');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const WEEK_MS = 7 * DAY_MS;
const PERIOD = { start: weekStart, step: WEEK_MS };   // fixed-length weeks → step is exact

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
    const days = Math.min(365, Math.max(7, parseInt(q.days, 10) || 180));   // H1 over ~26 weeks
    const threshold = Math.min(5, Math.max(0.01, parseFloat(q.threshold) || 0.20));
    const spreadThreshold = Math.min(10, Math.max(0.01, parseFloat(q.spread) || 0.25));

    const sb = getClient();
    const fromIso = new Date(asOfMs - days * DAY_MS).toISOString();
    const opts = { fromIso }; if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
    const by = await loadH1Parallel(sb, PAIRS, opts, 8);

    const built = buildIndices(by, { baseMs: H1_MS });
    if (!built.ok) return res.json({ ok: true, available: false, mode, reason: built.reason });

    const live = liveEvolution(built, asOfMs, built.lastMs, threshold, spreadThreshold, PERIOD);
    const history = historyScan(built, asOfMs, built.lastMs, { threshold, spreadThreshold, period: PERIOD, matrixDays: 26 });

    res.json({
      ok: true, available: true, mode, version: CONFIG.version, threshold, spreadThreshold,
      asOfUtc: iso(asOfMs), firstDataUtc: iso(built.firstMs), lastDataUtc: iso(built.lastMs),
      resolution: built.resolution, windowDays: days,
      meta: { periodName: 'Week so far', periodWord: 'week', openLabel: 'Monday 00:00 EAT week open', resolution: 'H1', historyUnit: 'EAT weeks', subDay: false },
      live, history,
      disclaimer: 'Relative-movement research (zero-sum 1/8 index on H1), UNVALIDATED. Not a signal, probability, or profitability claim; no orders.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
