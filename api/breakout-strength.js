'use strict';

/**
 * GET /api/breakout-strength — Breakout Strength & Signals, live or causal-replay snapshot
 * (research, UNVALIDATED). Computes the full methodology deterministically from stored H1:
 *   latest HTF break (per pair) → currency strength → strong-vs-weak qualification →
 *   fresh trigger break → signal.
 *
 *   ?strategy=daily|weekly|monthly   (default daily)
 *   ?asOf=<ms|ISO>                   causal replay cutoff (default live)
 *   ?view=overview|pairs|signals|detail|status   (default overview)
 *   ?pair=EUR_USD                    (view=detail)
 *   ?days=<n>                        recent-signal history window (default 60, 7..180)
 *
 * Signals only — no orders, stops, targets, or profitability/win-rate claims. A trigger
 * close is a REFERENCE price, not a guaranteed fill.
 */

const { getClient, cors } = require('./_db');
const { compute, STRATEGY_KEYS } = require('../research/breakout/service');
const { signalId } = require('../research/breakout/store');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// small in-memory cache (per warm lambda) — live views recompute at most every few minutes
const CACHE = new Map();
const TTL_MS = 4 * 60 * 1000;

function shapeSignal(s) {
  return {
    id: signalId(s), strategy: s.strategyKey, pair: s.pair, direction: s.direction,
    base: s.base, quote: s.quote, dirTf: s.dirTf, triggerTf: s.triggerTf,
    triggerOpenMs: s.triggerOpenMs, triggerCloseMs: s.triggerCloseMs, triggerCloseUtc: iso(s.triggerCloseMs),
    brokenBoundary: s.brokenBoundary, brokenLevel: s.brokenLevel, referenceClose: s.referenceClose,
    baseScore: s.baseScore, quoteScore: s.quoteScore, strengthSnapshot: s.strengthSnapshot,
    breakoutDetail: s.breakoutDetail, triggerDetail: s.triggerDetail,
  };
}

function shapeStrength(strength) {
  return Object.values(strength).map((s) => ({
    currency: s.currency, score: s.score, bull: s.bull, bear: s.bear,
    classification: s.classification, complete: s.complete, contributions: s.contributions,
  })).sort((a, b) => (a.complete !== b.complete ? (a.complete ? -1 : 1) : (b.score == null ? -99 : b.score) - (a.score == null ? -99 : a.score)));
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};
    const strategy = STRATEGY_KEYS.includes(String(q.strategy)) ? String(q.strategy) : 'daily';
    const view = ['overview', 'pairs', 'signals', 'detail', 'status'].includes(String(q.view)) ? String(q.view) : 'overview';
    const days = Math.min(180, Math.max(7, parseInt(q.days, 10) || 60));

    let asOfMs = Date.now(), mode = 'live';
    if (q.asOf != null && q.asOf !== '') {
      const t = /^\d+$/.test('' + q.asOf) ? parseInt(q.asOf, 10) : Date.parse(q.asOf);
      if (!isNaN(t) && t < Date.now()) { asOfMs = t; mode = 'historical'; }
    }

    const cacheKey = [strategy, mode, days, mode === 'live' ? Math.floor(asOfMs / TTL_MS) : asOfMs].join(':');
    const cached = CACHE.get(cacheKey);
    let r;
    if (cached && Date.now() - cached.at < TTL_MS) r = cached.r;
    else { r = await compute(getClient(), strategy, asOfMs, mode, { historyDays: days }); CACHE.set(cacheKey, { at: Date.now(), r }); }

    const meta = {
      strategy, dirTf: r.def.dirTf, triggerTf: r.def.triggerTf, version: r.def.version,
      label: r.def.label, threshold: r.def ? (r.def.params || {}).strongThreshold : null,
      alignment: 'EAT (UTC+3)', mode, asOfUtc: iso(asOfMs),
      disclaimer: 'Breakout methodology research (EAT-aligned, aggregated from H1), UNVALIDATED. Signals only — no orders, stops, targets, or profitability claims; a trigger close is a reference price, not a fill.',
    };

    if (!r.available) return res.json({ ok: true, available: false, mode, meta, reason: r.reason });

    const base = { ok: true, available: true, mode, meta, cutoffUtc: iso(r.cutoff), cutoffMs: r.cutoff, lastDataUtc: iso(r.lastMs), status: r.status };

    if (view === 'status') return res.json({ ...base, strength: shapeStrength(r.snap.strength) });
    if (view === 'pairs') return res.json({ ...base, pairStates: Object.values(r.snap.pairStates) });
    if (view === 'signals') return res.json({ ...base, signals: r.recent.map(shapeSignal), currentSignals: r.snap.signals.map(shapeSignal) });
    if (view === 'detail') {
      const pair = String(q.pair || '').toUpperCase();
      const te = r.snap.triggerEvals.find((x) => x.pair === pair) || null;
      const ps = r.snap.pairStates[pair] || null;
      const qrow = r.snap.qualification.all.find((x) => x.pair === pair) || null;
      return res.json({ ...base, pair, pairState: ps, qualification: qrow, triggerEval: te, strength: shapeStrength(r.snap.strength) });
    }
    // overview (default) — everything the main page needs in one fetch
    return res.json({
      ...base,
      strength: shapeStrength(r.snap.strength),
      qualification: r.snap.qualification.all,
      qualified: r.snap.qualification.qualified,
      pairStates: Object.values(r.snap.pairStates),
      triggerEvals: r.snap.triggerEvals,
      currentSignals: r.snap.signals.map(shapeSignal),
      recentSignals: r.recent.map(shapeSignal),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
