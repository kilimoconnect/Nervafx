'use strict';

/**
 * GET /api/currency-movement — Currency Movement Dashboard (research, UNVALIDATED).
 *
 * Per-currency movement for the 8 majors from completed M15 candles: normalized
 * movement score, breadth, persistence, causal onset, extension, plus a cross-window
 * heatmap. Decision support only — NOT a trade signal, probability, or edge.
 *
 *   ?window=1h|4h|12h|24h|5d   selected window (default 4h)
 *   ?currency=AUD              include the detail drawer for one currency
 *   ?asOf=<ms|ISO>             replay as-of a historical M15 close (causal)
 */

const { getClient, cors } = require('./_db');
const { loadM15Parallel } = require('../research/movement/dbload');
const { buildSeries } = require('../research/movement/engine');
const { buildDashboard } = require('../research/movement/payload');
const { CONFIG, PAIRS, windowByName } = require('../research/movement/config');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const window = windowByName((req.query && req.query.window) || '4h').name;
    const currency = (req.query && req.query.currency) || null;
    const asOfRaw = req.query && req.query.asOf;
    let nowMs = Date.now(), mode = 'live';
    if (asOfRaw != null && asOfRaw !== '') { const t = /^\d+$/.test('' + asOfRaw) ? parseInt(asOfRaw, 10) : Date.parse(asOfRaw); if (!isNaN(t) && t < Date.now()) { nowMs = t; mode = 'historical'; } }

    const sb = getClient();
    // ~150 days of M15 → enough non-overlapping samples for all windows incl. 5d.
    const fromIso = new Date(nowMs - 150 * 24 * 60 * 60 * 1000).toISOString();
    const opts = { fromIso }; if (mode === 'historical') opts.toIso = new Date(nowMs).toISOString();
    const by = await loadM15Parallel(sb, PAIRS, opts, 8);
    const series = buildSeries(by);
    const d = buildDashboard(series, nowMs, window, CONFIG, currency);
    if (!d.ok) return res.json({ ok: true, available: false, reason: d.reason || 'no data', mode });
    d.mode = mode;
    res.json({ ok: true, available: true, ...d });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
