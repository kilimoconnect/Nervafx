'use strict';

/**
 * GET /api/h4-evolution — H4-so-far % evolution on 5-minute candles (research, UNVALIDATED).
 *
 * Same engine as /api/currency-evolution, but the developing period is the current H4 block
 * (00/04/08/12/16/20 EAT, anchored to the EAT day) and the index is built from M5 candles, so the
 * intraday structure is finer. Returns the open-relative % path for all 8 currency indices through
 * the latest completed M5 of the developing H4 block, the dispersion "watch" windows, the
 * momentum-qualified currency strength, and a historical scan over past H4 blocks.
 *
 *   ?asOf=<ms|ISO>   causal replay (no look-ahead; defaults to live)
 *   ?days=<n>        history window to load/scan in days (default 5, cap 30 — M5 is heavy)
 *   ?threshold=<p>   best-movement % threshold (default 0.20)
 *   ?spread=<p>      dispersion (strongest−weakest) gate % (default 0.25)
 *
 * Relative-movement research only — NO execution, buy/sell signal, probability, or profitability.
 */

const { getClient, cors } = require('./_db');
const { loadM5Parallel } = require('../research/comparison/dbload');
const { buildIndices } = require('../research/comparison/index-build');
const { liveEvolution, historyScan, DEFAULT_THRESHOLD, DEFAULT_SPREAD } = require('../research/comparison/evolution');
const { h4Start } = require('../research/comparison/periods');
const { CONFIG, PAIRS, M5_MS, H4_MS } = require('../research/comparison/config');

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const PERIOD = { start: h4Start, step: H4_MS };

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
    const days = Math.min(30, Math.max(1, parseInt(q.days, 10) || 5));   // M5 is heavy — keep the window short
    const threshold = Math.min(5, Math.max(0.01, parseFloat(q.threshold) || 0.20));   // best-movement ± threshold (lowered from 0.25)
    const spreadThreshold = Math.min(10, Math.max(0.01, parseFloat(q.spread) || 0.25));   // dispersion gate (lowered from 0.30)

    const sb = getClient();
    const fromIso = new Date(asOfMs - days * DAY).toISOString();
    const opts = { fromIso }; if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
    const by = await loadM5Parallel(sb, PAIRS, opts, 8);

    const built = buildIndices(by, { baseMs: M5_MS });
    if (!built.ok) return res.json({ ok: true, available: false, mode, reason: built.reason });

    const live = liveEvolution(built, asOfMs, built.lastMs, threshold, spreadThreshold, PERIOD);
    const history = historyScan(built, asOfMs, built.lastMs, { threshold, spreadThreshold, period: PERIOD, matrixDays: 48 });

    res.json({
      ok: true, available: true, mode, version: CONFIG.version, threshold, spreadThreshold,
      asOfUtc: iso(asOfMs), firstDataUtc: iso(built.firstMs), lastDataUtc: iso(built.lastMs),
      resolution: built.resolution, windowDays: days,
      meta: { periodName: 'H4 so far', periodWord: 'H4 block', openLabel: 'H4 open', resolution: '5m', historyUnit: 'H4 blocks', subDay: true },
      live, history,
      disclaimer: 'Relative-movement research (zero-sum 1/8 index on 5m), UNVALIDATED. Not a signal, probability, or profitability claim; no orders.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
