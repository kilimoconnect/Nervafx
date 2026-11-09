'use strict';

/**
 * GET /api/currency-evolution — Today-so-far % evolution (research, UNVALIDATED).
 *
 * Returns the intraday open-relative % path for all 8 currency indices through the latest
 * completed M15 of the developing EAT day, plus a historical scan of how often each currency
 * reached ±threshold ("best movement") at any point in a day.
 *
 *   ?asOf=<ms|ISO>   causal replay (no look-ahead; defaults to live)
 *   ?days=<n>        history window to load/scan (default 120, cap 365)
 *   ?threshold=<p>   best-movement % threshold (default 0.25)
 *
 * Relative-movement research only — NO execution, buy/sell signal, probability, or profitability.
 */

const { getClient, cors } = require('./_db');
const { loadM15Parallel } = require('../research/comparison/dbload');
const { buildIndices } = require('../research/comparison/index-build');
const { liveEvolution, historyScan, DEFAULT_THRESHOLD, DEFAULT_SPREAD } = require('../research/comparison/evolution');
const { CONFIG, PAIRS } = require('../research/comparison/config');

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

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
    const days = Math.min(365, Math.max(2, parseInt(q.days, 10) || 120));
    const threshold = Math.min(5, Math.max(0.01, parseFloat(q.threshold) || DEFAULT_THRESHOLD));
    const spreadThreshold = Math.min(10, Math.max(0.01, parseFloat(q.spread) || DEFAULT_SPREAD));

    const sb = getClient();
    const fromIso = new Date(asOfMs - days * DAY).toISOString();
    const opts = { fromIso }; if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
    const by = await loadM15Parallel(sb, PAIRS, opts, 8);

    const built = buildIndices(by);
    if (!built.ok) return res.json({ ok: true, available: false, mode, reason: built.reason });

    const live = liveEvolution(built, asOfMs, built.lastMs, threshold, spreadThreshold);
    const history = historyScan(built, asOfMs, built.lastMs, { threshold, spreadThreshold });

    res.json({
      ok: true, available: true, mode, version: CONFIG.version, threshold, spreadThreshold,
      asOfUtc: iso(asOfMs), firstDataUtc: iso(built.firstMs), lastDataUtc: iso(built.lastMs),
      resolution: built.resolution, windowDays: days,
      live, history,
      disclaimer: 'Relative-movement research (zero-sum 1/8 index), UNVALIDATED. Not a signal, probability, or profitability claim; no orders.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
