'use strict';

/**
 * GET /api/breakout-chart — EAT-aligned candles for one pair + timeframe, with the breakout
 * annotations the module needs (the latest qualifying break, the evaluated trigger candle, and
 * the broken-boundary level). Separate from /api/currency-chart (which is UTC) so existing
 * charts are untouched. Honours ?asOf to hide candles after the cursor (completed only).
 *
 *   ?instrument=EUR_USD       a stored provider pair
 *   ?tf=H1|H4|D1|W1|MN1       timeframe (EAT-aligned; H1 as stored)
 *   ?asOf=<ms|ISO>            causal cutoff (default live)
 *   ?bars=<n>                 max bars returned (default 400, max 1500)
 */

const { getClient, cors } = require('./_db');
const { PAIRS, TF } = require('../research/breakout/config');
const { loadTf } = require('../research/comparison/dbload');
const { aggregateEat, completedAsOf } = require('../research/breakout/candles');
const { latestBreak } = require('../research/breakout/breakout');
const { triggerBreak } = require('../research/breakout/trigger');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const DAY = 24 * 60 * 60 * 1000;

function precisionFor(pair) { return pair.endsWith('_JPY') ? 3 : 5; }

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};
    const instrument = String(q.instrument || '').toUpperCase();
    if (!PAIRS.includes(instrument)) return res.status(400).json({ ok: false, error: 'unknown instrument' });
    const tf = TF[String(q.tf).toUpperCase()] ? String(q.tf).toUpperCase() : 'H1';
    const bars = Math.min(1500, Math.max(20, parseInt(q.bars, 10) || 400));

    let asOfMs = Date.now(), mode = 'live';
    if (q.asOf != null && q.asOf !== '') { const t = /^\d+$/.test('' + q.asOf) ? parseInt(q.asOf, 10) : Date.parse(q.asOf); if (!isNaN(t) && t < Date.now()) { asOfMs = t; mode = 'historical'; } }

    // load enough H1 to form `bars` of the requested TF (bounded)
    const spanDays = Math.min(430, Math.ceil((bars * (TF[tf].ms / DAY)) + 20));
    const opts = { withVolume: true, fromIso: new Date(asOfMs - spanDays * DAY).toISOString() };
    if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
    const h1 = await loadTf(getClient(), instrument, 'H1', opts);

    const all = completedAsOf(aggregateEat(h1, tf), asOfMs);
    const slice = all.slice(Math.max(0, all.length - bars));
    const candles = slice.map((c) => ({ time: Math.floor(c.openMs / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume == null ? undefined : c.volume }));

    const lb = latestBreak(all);                  // latest qualifying break on this TF
    const tb = triggerBreak(all);                 // latest completed candle's own break (for trigger TFs)

    res.json({
      ok: true, available: candles.length > 0, mode, instrument, tf,
      precision: precisionFor(instrument), alignment: 'EAT (UTC+3)',
      asOfUtc: iso(asOfMs), lastCloseUtc: all.length ? iso(all[all.length - 1].closeMs) : null,
      candles,
      latestBreak: lb.direction ? { direction: lb.direction, breakOpenMs: lb.breakOpenMs, breakOpenSec: Math.floor(lb.breakOpenMs / 1000), breakCloseMs: lb.breakCloseMs, brokenBoundary: lb.brokenBoundary, brokenLevel: lb.brokenLevel, ageCandles: lb.ageCandles } : { direction: 0, reason: lb.reason },
      latestCandleBreak: tb.break ? { direction: tb.break, boundary: tb.boundary, level: tb.level, openSec: Math.floor(tb.candle.openMs / 1000), closeMs: tb.candle.closeMs } : { direction: 0, reason: tb.reason },
      disclaimer: 'EAT-aligned candles aggregated from stored H1 (research). Completed candles only.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
