'use strict';

/**
 * GET /api/breakout-replay — interactive historical replay (deterministic as-of recompute;
 * NOT a filter of today's dashboard). Reuses the exact engine, so it reproduces the live
 * decisions for the same candles + settings. Read-only — writes nothing to the live tables.
 *
 *   ?strategy=daily|weekly|monthly
 *   ?at=<ms|ISO>              the selected replay time T (default now)
 *   ?tz=<IANA>               timezone the UI selected (echoed back; math is UTC internally)
 *   ?mode=live|whatif        whatif applies ?threshold to the whole period (hypothetical)
 *   ?threshold=4..7          whatif only
 *   ?windowDays=<n>          signal-history window before T (default 7, 1..60)
 *   ?step=next|prev&from=<ms> step to the adjacent trigger-candle close (returns its snapshot)
 *
 * Returns three clearly-separated blocks: (1) qualification at T, (2) trigger evaluation at
 * the latest completed trigger close ≤ T, (3) signals generated earlier in the window.
 */

const { getClient, cors } = require('./_db');
const { buildReplayContext, LOOKBACK_DAYS, evoSpanDays } = require('../research/breakout/service');
const { validParams } = require('../research/breakout/config');
const { replayAt, stepTriggerClose, stepM15Close } = require('../research/breakout/replay');
const { signalId } = require('../research/breakout/store');

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const DAY = 24 * 60 * 60 * 1000;

// Warm-lambda context cache so stepping/playing reuses one build. A context loaded from
// `loadedFromMs`/`evoLoadedFromMs` up to now fully contains any later T, so forward steps never
// reload. Reuse only when BOTH windows reach back far enough for this T (else rebuild wider).
const CTX_CACHE = new Map();
const CTX_TTL = 4 * 60 * 1000;
async function getReplayContext(sb, strategy, atMs, paramsOverride, windowDays) {
  const sig = paramsOverride ? JSON.stringify(validParams(paramsOverride)) : 'active';
  const key = strategy + '|' + sig + '|w' + windowDays;
  const needFrom = atMs - (LOOKBACK_DAYS[strategy] || 220) * DAY;             // fresh H1 start
  const needEvoFrom = atMs - evoSpanDays(strategy, windowDays) * DAY;         // fresh M15 start
  const hit = CTX_CACHE.get(key);
  if (hit && Date.now() - hit.builtAt < CTX_TTL && hit.r.available && hit.r.loadedFromMs <= needFrom && hit.r.evoLoadedFromMs <= needEvoFrom) return hit.r;
  const r = await buildReplayContext(sb, strategy, atMs, { paramsOverride, windowDays });
  if (r.available) CTX_CACHE.set(key, { builtAt: Date.now(), r });
  return r;
}

function shapeSignal(s) {
  return {
    id: signalId(s), strategy: s.strategyKey, pair: s.pair, direction: s.direction, base: s.base, quote: s.quote,
    dirTf: s.dirTf, triggerTf: s.triggerTf, triggerCloseMs: s.triggerCloseMs, triggerCloseUtc: iso(s.triggerCloseMs),
    brokenBoundary: s.brokenBoundary, brokenLevel: s.brokenLevel, referenceClose: s.referenceClose,
    baseScore: s.baseScore, quoteScore: s.quoteScore,
    conditionSnapshot: s.conditionSnapshot || s.strengthSnapshot, candidateDetail: s.candidateDetail,
    evoSnapshotMs: s.evoSnapshotMs, marketCloseMs: s.marketCloseMs,
    breakoutDetail: s.breakoutDetail, triggerDetail: s.triggerDetail, version: s.version,
  };
}

const CLASS_RANK = { strong: 0, mixed: 1, weak: 2, insufficient: 3 };
function shapeStrength(condition) {
  return Object.values(condition).map((s) => ({
    currency: s.currency, classification: s.classification, complete: s.complete, score: s.score,
    periodPct: s.periodPct, periodPeak: s.periodPeak, periodTrough: s.periodTrough,
    fast: s.fast, slow: s.slow, paceChange: s.paceChange,
  })).sort((a, b) => (CLASS_RANK[a.classification] - CLASS_RANK[b.classification]) || ((b.score == null ? -999 : b.score) - (a.score == null ? -999 : a.score)));
}

function blocksFor(rep) {
  return {
    atMs: rep.atMs, atUtc: iso(rep.atMs), latestTriggerCloseMs: rep.latestTriggerCloseMs, latestTriggerCloseUtc: iso(rep.latestTriggerCloseMs), atBetweenCloses: rep.atBetweenCloses,
    // (1) qualification at the selected time
    qualificationAtT: { strength: shapeStrength(rep.snapshot.strength), qualification: rep.snapshot.qualification.all, qualified: rep.snapshot.qualification.qualified, pairStates: Object.values(rep.snapshot.pairStates) },
    // (2) trigger evaluation at the latest completed trigger close
    triggerEvaluation: { triggerEvals: rep.snapshot.triggerEvals, signalsAtClose: rep.snapshot.signals.map(shapeSignal) },
    // (3) signals generated earlier in the window (each judged at its own close)
    signalsInWindow: rep.signalsInWindow.map(shapeSignal),
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};
    const strategy = ['daily', 'weekly', 'monthly'].includes(String(q.strategy)) ? String(q.strategy) : 'daily';
    const mode = String(q.mode) === 'whatif' ? 'whatif' : 'live';
    const tz = typeof q.tz === 'string' && q.tz ? q.tz : 'UTC';
    const windowDays = Math.min(60, Math.max(1, parseInt(q.windowDays, 10) || 7));
    const stepMode = String(q.stepMode) === 'evolution' ? 'evolution' : 'trigger';   // M15 vs trigger-close stepping
    // what-if overrides the v2 condition params (breadth / deadbands); actual records are never changed.
    let paramsOverride = null;
    if (mode === 'whatif') {
      const o = {};
      if (q.breadthMin != null) o.breadthMin = q.breadthMin;
      if (q.dirDeadband != null) o.dirDeadband = q.dirDeadband;
      if (q.effDeadband != null) o.effDeadband = q.effDeadband;
      if (Object.keys(o).length) paramsOverride = o;
    }

    let atMs = Date.now();
    if (q.at != null && q.at !== '') { const t = /^\d+$/.test('' + q.at) ? parseInt(q.at, 10) : Date.parse(q.at); if (!isNaN(t)) atMs = Math.min(t, Date.now()); }

    // Build the context over data up to NOW (causal cut happens at T), so we can step forward.
    const step = String(q.step);
    const r = await getReplayContext(getClient(), strategy, atMs, paramsOverride, windowDays);
    if (!r.available) return res.json({ ok: true, available: false, mode, reason: r.reason });

    let effectiveAt = Math.min(atMs, r.cutoff), stepped = null;
    if (step === 'next' || step === 'prev') {
      const from = /^\d+$/.test('' + q.from) ? parseInt(q.from, 10) : effectiveAt;
      const dir = step === 'next' ? 1 : -1;
      const target = stepMode === 'evolution' ? stepM15Close(r.ctx, from, dir, r.cutoff) : stepTriggerClose(r.ctx, from, dir, r.cutoff);
      if (target == null) {
        return res.json({ ok: true, available: true, mode, strategy, tz, stepMode, stepped: null, atEnd: step === 'next', atStart: step === 'prev', message: 'No ' + step + ' ' + (stepMode === 'evolution' ? 'M15 index' : 'completed trigger') + ' close in range.' });
      }
      effectiveAt = target; stepped = target;
    }

    const windowFrom = effectiveAt - windowDays * DAY;
    const rep = replayAt(r.ctx, effectiveAt, windowFrom);

    res.json({
      ok: true, available: true, mode, strategy, tz, stepMode,
      meta: {
        dirTf: r.def.dirTf, triggerTf: r.def.triggerTf, version: r.def.version, label: r.def.label,
        methodology: 'Evolution-qualified breakout (v2)', params: r.def.params,
        windows: r.def.condition ? { fast: r.def.condition.fastLabel, slow: r.def.condition.slowLabel, period: r.def.condition.periodLabel } : null,
        alignment: 'EAT (UTC+3)',
        configMode: mode === 'whatif' ? 'what-if (hypothetical recalculation)' : 'historical reconstruction',
        note: mode === 'whatif' ? 'Hypothetical: the selected condition params are applied to the whole period; actual recorded signals are never overwritten.' : 'Reconstructed from stored historical candles; cannot prove what the live feed delivered at the time.',
        windowDays, stepped: stepped == null ? null : iso(stepped),
      },
      status: r.status, cutoffUtc: iso(r.cutoff),
      replay: blocksFor(rep),
      disclaimer: 'Deterministic as-of recompute (research, UNVALIDATED). Replay is read-only; results before this module existed are a historical reconstruction, not live signals.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 120;
