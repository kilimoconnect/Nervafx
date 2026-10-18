'use strict';

/**
 * GET /api/pad1h1 — Daily → H1 pullback-continuation research frame (PA_D1_H1_CONTINUATION).
 *
 * Loads completed H1 candles for ONE pair, uses H1 directly as the entry series and
 * aggregates D1 (UTC-day, DST-invariant) as the trend series, and returns the as-of
 * research frame. Reuses the shared, verified core. Read-only; price action only; no
 * order path. RESEARCH / UNVALIDATED — no profitability is claimed.
 *
 *   ?pair=EUR_USD   one of the 28 majors (default EUR_USD)
 *   ?asOf=<ms|ISO>  build AS OF a historical close (causal); default live
 */

const { getClient, cors } = require('./_db');
const { loadH1, loadH1Parallel } = require('../research/paw1h4/dbload');
const { scanAll } = require('../research/paw1h4/scan');
const d1h1 = require('../research/pad1h1');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    let pair = (req.query && req.query.pair) || 'EUR_USD';
    if (!d1h1.PAIRS.includes(pair)) pair = 'EUR_USD';

    const asOfRaw = req.query && req.query.asOf;
    let nowMs = Date.now(), mode = 'live';
    if (asOfRaw != null && asOfRaw !== '') { const t = /^\d+$/.test('' + asOfRaw) ? parseInt(asOfRaw, 10) : Date.parse(asOfRaw); if (!isNaN(t) && t < Date.now()) { nowMs = t; mode = 'historical'; } }

    const sb = getClient();
    const fromIso = new Date(nowMs - 200 * 24 * 60 * 60 * 1000).toISOString();   // ~140 trading days → enough D1 structure
    const opts = { fromIso };
    if (mode === 'historical') opts.toIso = new Date(nowMs).toISOString();

    // Multi-pair scan: rank all 28 pairs by current tradeability.
    if (req.query && (req.query.scan === '1' || req.query.scan === 'true')) {
      const all = await loadH1Parallel(sb, d1h1.PAIRS, opts, 8);
      const scan = scanAll(all, d1h1.PAIRS, d1h1.CONFIG, d1h1.TF_D1H1, nowMs);
      return res.json({ ok: true, scan, strategyId: d1h1.CONFIG.strategyId, trendLabel: 'D1', entryLabel: 'H1', asOfUtc: new Date(nowMs).toISOString(), mode, pairs: d1h1.PAIRS });
    }

    const h1 = (await loadH1(sb, [pair], opts))[pair] || [];
    if (!h1.length) return res.json({ ok: true, available: false, reason: 'NO_H1_DATA', pair, mode });

    const frame = d1h1.frame(h1, pair, nowMs);
    frame.mode = mode; frame.pairs = d1h1.PAIRS;
    res.json({ ok: true, available: true, ...frame });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
