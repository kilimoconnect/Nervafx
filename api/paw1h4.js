'use strict';

/**
 * GET /api/paw1h4 — Weekly → H4 pullback-continuation research frame (PA_W1_H4_CONTINUATION).
 *
 * Loads completed H1 candles for ONE pair from backtest_candles, aggregates W1 + H4
 * (UTC-anchored, DST-invariant), and returns the as-of research frame (weekly bias,
 * H4 state machine, frozen levels, suggested trade, data-quality). Read-only; price
 * action only; no order path. RESEARCH / UNVALIDATED — no profitability is claimed.
 *
 *   ?pair=EUR_USD        one of the 28 majors (default EUR_USD)
 *   ?asOf=<ms|ISO>       build AS OF a historical close (causal); default live
 */

const { getClient, cors } = require('./_db');
const { loadH1, loadH1Parallel } = require('../research/paw1h4/dbload');
const { buildFrame } = require('../research/paw1h4/frame');
const { scanAll } = require('../research/paw1h4/scan');
const { TF_W1H4 } = require('../research/paw1h4/pipeline');
const { CONFIG, PAIRS } = require('../research/paw1h4/config');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    let pair = (req.query && req.query.pair) || 'EUR_USD';
    if (!PAIRS.includes(pair)) pair = 'EUR_USD';

    const asOfRaw = req.query && req.query.asOf;
    let nowMs = Date.now(), mode = 'live';
    if (asOfRaw != null && asOfRaw !== '') { const t = /^\d+$/.test('' + asOfRaw) ? parseInt(asOfRaw, 10) : Date.parse(asOfRaw); if (!isNaN(t) && t < Date.now()) { nowMs = t; mode = 'historical'; } }

    const sb = getClient();
    const fromIso = new Date(nowMs - 500 * 24 * 60 * 60 * 1000).toISOString();   // ~70 weeks → enough W1 structure
    const opts = { fromIso };
    if (mode === 'historical') opts.toIso = new Date(nowMs).toISOString();

    // Multi-pair scan: rank all 28 pairs by current tradeability.
    if (req.query && (req.query.scan === '1' || req.query.scan === 'true')) {
      const all = await loadH1Parallel(sb, PAIRS, opts, 8);
      const scan = scanAll(all, PAIRS, CONFIG, TF_W1H4, nowMs);
      return res.json({ ok: true, scan, strategyId: CONFIG.strategyId, trendLabel: 'W1', entryLabel: 'H4', asOfUtc: new Date(nowMs).toISOString(), mode, pairs: PAIRS });
    }

    const h1byPair = await loadH1(sb, [pair], opts);
    const h1 = h1byPair[pair] || [];
    if (!h1.length) return res.json({ ok: true, available: false, reason: 'NO_H1_DATA', pair, mode });

    const frame = buildFrame(h1, pair, nowMs, CONFIG);
    frame.mode = mode; frame.pairs = PAIRS;
    res.json({ ok: true, available: true, ...frame });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
