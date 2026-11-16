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
const { PAIRS, TF, STRATEGIES, STRATEGY_KEYS } = require('../research/breakout/config');
const { loadTf, loadM15Parallel } = require('../research/comparison/dbload');
const { aggregateEat, completedAsOf } = require('../research/breakout/candles');
const { latestBreak } = require('../research/breakout/breakout');
const { triggerBreak } = require('../research/breakout/trigger');
const { buildIndices, idxAtOrBefore } = require('../research/comparison/index-build');
const { periodPath } = require('../research/comparison/candles');
const { CURRENCIES } = require('../research/comparison/config');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const DAY = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = { daily: 2, weekly: 9, monthly: 35 };   // M15 span to cover the period baseline

function precisionFor(pair) { return pair.endsWith('_JPY') ? 3 : 5; }

/** The 8-currency Evolution index, each as an open-relative % path from the strategy's period baseline. */
async function evolutionView(sb, strategy, asOfMs, mode) {
  const cond = STRATEGIES[strategy].condition;
  const spanDays = PERIOD_DAYS[strategy] || 2;
  const opts = { fromIso: new Date(asOfMs - spanDays * DAY).toISOString() };
  if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
  const by = await loadM15Parallel(sb, PAIRS, opts, 8);
  const built = buildIndices(by);
  if (!built.ok) return { ok: true, available: false, view: 'evolution', strategy, reason: built.reason };
  const cutoff = Math.min(asOfMs, built.lastMs);
  const startMs = cond.periodStart(cutoff);
  const series = CURRENCIES.map((ccy) => {
    const path = periodPath(built, ccy, startMs, cutoff);
    const pts = (path.points || []).map((p) => ({ sec: Math.floor(p.ms / 1000) + 3 * 3600, pct: +(+p.pct).toFixed(4) }));   // +3h = EAT display
    const last = pts.length ? pts[pts.length - 1].pct : null;
    return { currency: ccy, ok: !!path.ok, last, points: pts };
  }).sort((a, b) => (b.last == null ? -999 : b.last) - (a.last == null ? -999 : a.last));
  return {
    ok: true, available: true, view: 'evolution', strategy, mode,
    periodLabel: cond.periodLabel, periodStartUtc: iso(startMs), cutoffUtc: iso(cutoff),
    resolution: 'M15', alignment: 'EAT (UTC+3)', series,
    disclaimer: 'Zero-sum 1/8 currency index, open-relative % from the period baseline (research, UNVALIDATED).',
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};

    let asOfMs0 = Date.now(), mode0 = 'live';
    if (q.asOf != null && q.asOf !== '') { const t = /^\d+$/.test('' + q.asOf) ? parseInt(q.asOf, 10) : Date.parse(q.asOf); if (!isNaN(t) && t < Date.now()) { asOfMs0 = t; mode0 = 'historical'; } }

    // Evolution view: the 8-currency index % paths from the strategy's period baseline.
    if (String(q.view) === 'evolution') {
      const strategy = STRATEGY_KEYS.includes(String(q.strategy)) ? String(q.strategy) : 'daily';
      return res.json(await evolutionView(getClient(), strategy, asOfMs0, mode0));
    }

    const instrument = String(q.instrument || '').toUpperCase();
    if (!PAIRS.includes(instrument)) return res.status(400).json({ ok: false, error: 'unknown instrument' });
    const tf = TF[String(q.tf).toUpperCase()] ? String(q.tf).toUpperCase() : 'H1';
    const bars = Math.min(1500, Math.max(20, parseInt(q.bars, 10) || 400));

    const asOfMs = asOfMs0, mode = mode0;

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
