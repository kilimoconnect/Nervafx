'use strict';

/**
 * GET /api/pad1h1 — Daily → H1 context-driven multi-approach research (PA_D1_H1_MULTI).
 *
 * Loads completed H1 for ONE pair; H1 is the entry series and D1 (UTC-day aggregate,
 * DST-invariant) the trend series. Returns the as-of multi-approach frame (daily
 * context + the four approaches) by DEFAULT. Price action only; read-only; no order
 * path. RESEARCH / UNVALIDATED — a ranked candidate is not a demonstrated trade.
 *
 *   ?pair=EUR_USD   one of the 28 majors (default EUR_USD)
 *   ?asOf=<ms|ISO>  build AS OF a historical close (causal); default live
 *   ?scan=1         28-pair approach scanner
 *   ?legacy=1       the ARCHIVED original pullback-only frame (PA_D1_H1_CONTINUATION)
 */

const { getClient, cors } = require('./_db');
const { loadH1, loadH1Parallel } = require('../research/paw1h4/dbload');
const { buildApproachFrame, scanApproaches, MTF_D1H1 } = require('../research/paw1h4/approaches');
const { CONFIG, PAIRS } = require('../research/paw1h4/config');
const d1h1 = require('../research/pad1h1');   // archived legacy engine

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
    const fromIso = new Date(nowMs - 300 * 24 * 60 * 60 * 1000).toISOString();   // ~210 trading days → rich D1 structure
    const opts = { fromIso };
    if (mode === 'historical') opts.toIso = new Date(nowMs).toISOString();

    // 28-pair approach scanner.
    if (req.query && (req.query.scan === '1' || req.query.scan === 'true')) {
      const all = await loadH1Parallel(sb, PAIRS, opts, 8);
      const scan = PAIRS.map((p) => { try { return scanApproaches(all[p] || [], p, nowMs, CONFIG, MTF_D1H1); } catch (e) { return { pair: p, bias: 'UNAVAILABLE', balance: null, location: 'ERROR', best: null, score: -1 }; } });
      scan.sort((a, b) => (b.score - a.score) || a.pair.localeCompare(b.pair));
      return res.json({ ok: true, scan, strategyId: 'PA_D1_H1_MULTI', asOfUtc: new Date(nowMs).toISOString(), mode, pairs: PAIRS });
    }

    const h1 = (await loadH1(sb, [pair], opts))[pair] || [];
    if (!h1.length) return res.json({ ok: true, available: false, reason: 'NO_H1_DATA', pair, mode });

    // Archived original (pullback-only) frame, preserved for reproducible comparison.
    if (req.query && (req.query.legacy === '1' || req.query.legacy === 'true')) {
      const frame = d1h1.frame(h1, pair, nowMs); frame.mode = mode; frame.pairs = PAIRS;
      return res.json({ ok: true, available: true, archived: true, ...frame });
    }

    // Default = the new multi-approach Daily→H1 frame.
    const frame = buildApproachFrame(h1, pair, nowMs, CONFIG, MTF_D1H1);
    frame.mode = mode; frame.pairs = PAIRS;
    res.json({ ok: true, available: true, ...frame });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
