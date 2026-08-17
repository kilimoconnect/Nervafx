'use strict';

/**
 * NervaFX Liquidity Failure Engine — snapshot orchestration.
 *
 * evaluatePair() is a PURE, deterministic function: same candles + same
 * evaluation time ⇒ identical buckets. scanSnapshot() adds the DB fetch,
 * seven-at-a-time batching, per-pair isolation, coverage reuse and an immutable
 * historical cache. Outcomes are never included — this is point-in-time replay.
 */

const {
  HOUR_MS, M15_MS, PAIRS, CONFIG, EVAL_MODE, EVENT_STATE, MSS_STATUS, ORIENTATION,
} = require('./_lfe-constants');
const { atrSeries, atrNowOf, emaSeries } = require('./_lfe-math');
const { buildLevels } = require('./_lfe-level');
const { detectFailures } = require('./_lfe-failure');
const { confirmM15 } = require('./_lfe-mss');
const { buildSignal, applyCorrelationFilter } = require('./_lfe-signal');
const { buildEvaluationContext } = require('./_lfe-evaltime');
const { getCoverage } = require('./_lfe-coverage');
const { fetchPairData } = require('./_lfe-data');

function lastNonNull(arr) {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

/** Nearest opposing liquidity level for target projection. */
function nearestOpposing(levels, direction, price) {
  let best = null;
  for (const l of levels) {
    if (direction === 'SELL') {
      if (l.orientation === ORIENTATION.SUPPORT && l.centre < price && (best == null || l.centre > best)) best = l.centre;
    } else if (l.orientation === ORIENTATION.RESISTANCE && l.centre > price && (best == null || l.centre < best)) best = l.centre;
  }
  return best;
}

/** Display-safe event view — never carries eventual-outcome data. */
function slimEvent(ev, extra) {
  return Object.assign({
    eventKey: ev.eventKey, pair: ev.pair, direction: ev.direction, failedSide: ev.failedSide,
    setupType: ev.setupType, levelType: ev.levelType, levelCentre: ev.levelCentre, levelScore: ev.levelScore,
    state: ev.state, attackStartMs: ev.attackStartMs, breachAtMs: ev.breachAtMs, breakoutAtMs: ev.breakoutAtMs,
    failureAtMs: ev.failureAtMs, sweepExtreme: ev.sweepExtreme, h1Atr: ev.h1Atr, zoneWidth: ev.zoneWidth,
    zoneLow: ev.zoneLow, zoneHigh: ev.zoneHigh, qualityPoints: ev.qualityPoints,
    returnOffset: ev.returnOffset, strong: ev.strong, breakout: ev.breakout, failure: ev.failure,
    transitions: ev.transitions, // state-transition timeline up to evalMs (no outcomes)
  }, extra || {});
}

/**
 * Evaluate one pair at evalMs. `data` = { h1, m15, d1 } of completed candles.
 * `ctx` may carry { rotation: {baseDelta, quoteDelta} } for this pair.
 */
function evaluatePair(pair, data, evalMs, ctx, cfg) {
  cfg = cfg || CONFIG;
  ctx = ctx || {};
  const out = {
    pair, confirmed: [], watch: [], pendingDelayed: [], pendingM15: [],
    accepted: [], expiredInvalidated: [], warnings: [], error: null,
  };
  const h1 = data.h1 || [];
  const m15 = data.m15 || [];
  const d1 = data.d1 || [];

  if (h1.length < cfg.history.minH1) { out.error = 'INSUFFICIENT_H1'; out.warnings.push(`h1=${h1.length}<${cfg.history.minH1}`); return out; }
  const atr = atrSeries(h1, cfg.atr.h1Period);
  const atrNow = atrNowOf(atr);
  if (!atrNow) { out.error = 'NO_ATR'; return out; }
  if (m15.length < cfg.history.minM15) out.warnings.push(`m15=${m15.length}<${cfg.history.minM15}`);

  const { levels } = buildLevels({ candles: h1, d1Candles: d1, atr, atrNow, evalMs, pair, cfg });
  const events = detectFailures(levels, h1, atr, atrNow, pair, cfg);

  const closes = h1.map((c) => c.close);
  const ema20 = emaSeries(closes, cfg.ema.h1Periods[0]);
  const ema50 = emaSeries(closes, cfg.ema.h1Periods[1]);
  const m15Atr = m15.length ? atrSeries(m15, cfg.atr.m15Period) : [];
  const m15AtrNow = atrNowOf(m15Atr);
  const idxByOpen = new Map(h1.map((c, i) => [c.openMs, i]));

  for (const ev of events) {
    if (ev.state === EVENT_STATE.ACCEPTED) { out.accepted.push(slimEvent(ev)); continue; }
    if (ev.state === EVENT_STATE.EXPIRED) { out.expiredInvalidated.push(slimEvent(ev, { reason: 'H1_EXPIRED' })); continue; }
    if (ev.state === EVENT_STATE.DELAYED_FAILURE_PENDING) { out.pendingDelayed.push(slimEvent(ev)); continue; }

    // FAILURE_CONFIRMED (immediate or delayed) → seek M15 confirmation.
    const fIdx = idxByOpen.get(ev.failureAtMs - HOUR_MS);
    const emaCtx = {
      ema20: fIdx != null ? ema20[fIdx] : lastNonNull(ema20),
      ema50: fIdx != null ? ema50[fIdx] : lastNonNull(ema50),
      failureClose: fIdx != null ? h1[fIdx].close : null,
    };
    const conf = confirmM15(ev, m15, m15Atr, { evalMs, m15AtrNow, cfg });
    const entryRef = conf.nextOpen != null ? conf.nextOpen : ev.levelCentre;
    const sctx = Object.assign({}, emaCtx, {
      nextOpen: conf.nextOpen, evalMs, opposingLevel: nearestOpposing(levels, ev.direction, entryRef),
      rotation: ctx.rotation || null, spread: 0, contextPoints: 0,
    });
    const sig = buildSignal(ev, conf, sctx, cfg);
    // Attach the event + confirmation detail so cards can render level, breach,
    // failure, measurements and the transition timeline without extra lookups.
    sig.event = slimEvent(ev);
    sig.confirmation = {
      status: conf.status, breakLevel: conf.breakLevel, confirmAtMs: conf.confirmAtMs,
      m15Buffer: conf.m15Buffer, breachTime: conf.breachTime,
    };

    switch (conf.status) {
      case MSS_STATUS.CONFIRMED:
        (sig.isSignal ? out.confirmed : out.watch).push(sig); break;
      case MSS_STATUS.WAITING:
      case MSS_STATUS.PENDING:
        out.pendingM15.push(sig); break;
      case MSS_STATUS.INVALIDATED:
        out.expiredInvalidated.push(slimEvent(ev, { reason: 'M15_INVALIDATED' })); break;
      case MSS_STATUS.EXPIRED:
        out.expiredInvalidated.push(slimEvent(ev, { reason: 'M15_EXPIRED' })); break;
      default: // UNCONFIRMED — event stays visible, no trade signal
        out.watch.push(sig); break;
    }
  }
  return out;
}

// ── Time resolution ─────────────────────────────────────────────────────────
function latestLabel(coverage) {
  const ageMs = Date.now() - coverage.latestAvailable;
  return ageMs <= 20 * 60 * 1000 ? 'Live' : 'Latest available historical data';
}

/**
 * Resolve request → evaluation context, or a structured validation error that
 * carries the valid range.
 */
function resolveSnapshotTime(input, coverage) {
  const opts = { displayTimezone: input.timezone || 'UTC' };
  if (input.mode === EVAL_MODE.LATEST_AVAILABLE) {
    // no time → default is latest available
  } else if (input.at != null) {
    opts.iso = input.at;
  }
  const ctx = buildEvaluationContext(coverage, opts);
  if (!ctx.ok) {
    return {
      ok: false,
      error: {
        code: ctx.reason,
        message: 'Requested time is outside available coverage.',
        validRange: { earliest: coverage.earliestSelectableIso, latest: coverage.commonLatestIso },
      },
    };
  }
  return { ok: true, ctx };
}

// ── Caches ──────────────────────────────────────────────────────────────────
let _covCache = null; // { value, ts }
const COV_TTL_MS = 60 * 1000;
const _snapCache = new Map(); // key `${evalMs}:${version}` → body (immutable historical only)
const SNAP_CACHE_MAX = 200;

async function getCoverageCached(sb, force) {
  if (!force && _covCache && Date.now() - _covCache.ts < COV_TTL_MS) return _covCache.value;
  const value = await getCoverage(sb);
  _covCache = { value, ts: Date.now() };
  return value;
}

function snapKey(evalMs, version) { return `${evalMs}:${version}`; }

// ── Full snapshot ───────────────────────────────────────────────────────────
async function scanSnapshot(sb, ctx, coverage, opts) {
  opts = opts || {};
  const cfg = opts.cfg || CONFIG;
  const evalMs = ctx.evaluationMs;
  const cacheKey = snapKey(evalMs, cfg.version);

  // Cache every snapshot by (evalMs, version). Historical moments are immutable;
  // the latest-available evalMs is stable until coverage advances (hourly), so
  // caching it makes repeated loads instant without serving stale data.
  if (_snapCache.has(cacheKey)) return _snapCache.get(cacheKey);

  const pairs = opts.pairs && opts.pairs.length ? opts.pairs : PAIRS;
  const perPair = [];
  const errors = [];

  // Seven at a time, one shared evalMs, isolated per-pair failures.
  for (let i = 0; i < pairs.length; i += 7) {
    const batch = pairs.slice(i, i + 7);
    const results = await Promise.all(batch.map(async (pair) => {
      try {
        const data = await fetchPairData(sb, pair, evalMs);
        return evaluatePair(pair, data, evalMs, { rotation: null }, cfg);
      } catch (e) {
        return { pair, error: e.message, confirmed: [], watch: [], pendingDelayed: [], pendingM15: [], accepted: [], expiredInvalidated: [], warnings: [] };
      }
    }));
    perPair.push(...results);
  }

  const body = {
    engineVersion: cfg.version,
    mode: ctx.mode,
    latestLabel: ctx.mode === EVAL_MODE.LATEST_AVAILABLE ? latestLabel(coverage) : null,
    requestedTime: ctx.requestedTime,
    normalizedTime: ctx.evaluationTimeUtc,
    lastUsableH1Close: ctx.lastCompletedH1,
    displayTimezone: ctx.displayTimezone,
    coverage: {
      commonEarliest: coverage.commonEarliestRawIso,
      earliestSelectable: coverage.earliestSelectableIso,
      commonLatest: coverage.commonLatestIso,
      warnings: coverage.warnings,
    },
    confirmedSignals: [],
    watchCandidates: [],
    pendingDelayedFailures: [],
    pendingM15Confirmations: [],
    acceptedBreakouts: [],
    recentlyExpiredOrInvalidated: [],
    pairErrors: [],
    partialDataWarnings: [],
  };

  for (const r of perPair) {
    if (r.error) { body.pairErrors.push({ pair: r.pair, error: r.error }); errors.push(r.pair); }
    if (r.warnings && r.warnings.length) body.partialDataWarnings.push({ pair: r.pair, warnings: r.warnings });
    body.confirmedSignals.push(...r.confirmed);
    body.watchCandidates.push(...r.watch);
    body.pendingDelayedFailures.push(...r.pendingDelayed);
    body.pendingM15Confirmations.push(...r.pendingM15);
    body.acceptedBreakouts.push(...r.accepted);
    body.recentlyExpiredOrInvalidated.push(...r.expiredInvalidated);
  }

  // Correlation ranking across confirmed signals; strongest first.
  body.confirmedSignals = applyCorrelationFilter(body.confirmedSignals)
    .sort((a, b) => ((b.score ? b.score.total : 0) - (a.score ? a.score.total : 0)));

  if (_snapCache.size >= SNAP_CACHE_MAX) _snapCache.delete(_snapCache.keys().next().value);
  _snapCache.set(cacheKey, body);
  return body;
}

module.exports = {
  evaluatePair, nearestOpposing, resolveSnapshotTime, latestLabel,
  getCoverageCached, scanSnapshot, _snapCache,
};
