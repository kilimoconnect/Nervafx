'use strict';

/**
 * GET /api/currency-comparison — Currency Candle Comparison (research, UNVALIDATED).
 *
 * Relative index candles for the 8 majors, built from synchronized M15 pair log-returns
 * (zero-sum 1/8 construction). Three views; per-currency highlight candle + 2 context
 * candles, metrics, breadth, and an open-relative mini-chart. Research / pair-selection
 * only — NO execution, buy/sell signal, probability, or profitability claim.
 *
 *   ?view=previousDay|todaySoFar|sessions   (default previousDay)
 *   ?session=asia|london|newyork            (sessions view; default london)
 *   ?currency=AUD                           include the selected-currency detail
 *   ?asOf=<ms|ISO>                          causal historical replay (no look-ahead)
 */

const { getClient, cors } = require('./_db');
const { loadM15Parallel } = require('../research/movement/dbload');
const { buildComparison } = require('../research/comparison/payload');
const { CONFIG, PAIRS } = require('../research/comparison/config');

const VIEWS = ['previousDay', 'todaySoFar', 'sessions'];
const DAY = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};
    const view = VIEWS.indexOf(q.view) >= 0 ? q.view : 'previousDay';
    const session = q.session || null;
    const currency = q.currency || null;

    let asOfMs = Date.now(), mode = 'live';
    if (q.asOf != null && q.asOf !== '') {
      const t = /^\d+$/.test('' + q.asOf) ? parseInt(q.asOf, 10) : Date.parse(q.asOf);
      if (!isNaN(t) && t < Date.now()) { asOfMs = t; mode = 'historical'; }
    }

    const sb = getClient();
    // Sessions walk back up to 20 days to find 3 completed occurrences — load a safe window.
    const fromIso = new Date(asOfMs - 28 * DAY).toISOString();
    const opts = { fromIso }; if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
    const by = await loadM15Parallel(sb, PAIRS, opts, 8);

    const payload = buildComparison(by, { asOfMs, view, session, currency }, CONFIG);
    payload.mode = mode;
    if (!payload.ok) return res.json({ ok: true, available: false, mode, reason: payload.reason, firstDataUtc: payload.firstDataUtc, lastDataUtc: payload.lastDataUtc });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
