'use strict';

/**
 * Service layer for the Breakout API handlers (methodology v2, Evolution-based). Loads H1
 * (triggers + diagnostic higher-TF structure) AND M15 (the zero-sum 1/8 Evolution index),
 * builds the engine context, and computes live/replay snapshots. Keeps the handlers thin.
 *
 * M15 is loaded only as deep as the signal-history / replay window needs (period baseline +
 * slow window + the window itself), far less than the H1 trigger lookback, to stay within the
 * function time budget. A small in-memory cache lives in the handlers.
 */

const { PAIRS, STRATEGIES, STRATEGY_KEYS, DEFAULT_PARAMS, validParams, strategyDef, TF } = require('./config');
const { loadH1Parallel, loadM15Parallel } = require('../comparison/dbload');
const { buildContext, snapshotAt } = require('./evaluate');
const { sweepSignals, latestTriggerClose } = require('./replay');
const { ensureVersion, putSignals, putPairStates, putDecisionSnapshot, getCursor, setCursor } = require('./store');

const DAY = 24 * 60 * 60 * 1000;
// H1 history per strategy so the trigger TF + diagnostic HTF have depth.
const LOOKBACK_DAYS = { daily: 220, weekly: 430, monthly: 430 };
// M15 Evolution index: the slow window (in days, + margin) and the period baseline span.
const SLOW_BUFFER_DAYS = { daily: 1, weekly: 2, monthly: 6 };
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 31 };
/** Days of M15 needed to evaluate a `windowDays`-long history/replay window (index lookback included). */
function evoSpanDays(key, windowDays) {
  return (windowDays || 60) + (SLOW_BUFFER_DAYS[key] || 2) + (PERIOD_DAYS[key] || 1) + 1;
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** The active v2 condition params for a strategy (stored version, else defaults). */
async function activeParams(sb, strategyKey) {
  try {
    const { data } = await sb.from('breakout_settings_versions')
      .select('params,created_at').eq('strategy_key', strategyKey).eq('active', true)
      .order('created_at', { ascending: false }).limit(1);
    if (data && data[0] && data[0].params) return validParams(data[0].params);
  } catch (_) { /* table may not exist yet → defaults */ }
  return validParams(DEFAULT_PARAMS);
}

/** Last completed-H1 close across all pairs. */
function lastDataMs(byPair) {
  let m = 0;
  for (const p of PAIRS) { const rows = byPair[p]; if (rows && rows.length) { const r = rows[rows.length - 1]; const c = r.openMs + TF.H1.ms; if (c > m) m = c; } }
  return m || null;
}
function firstDataMs(byPair) {
  let m = Infinity;
  for (const p of PAIRS) { const rows = byPair[p]; if (rows && rows.length) { if (rows[0].openMs < m) m = rows[0].openMs; } }
  return Number.isFinite(m) ? m : null;
}

/** Per-currency data completeness (how many of the 8 have a complete v2 condition). */
function dataStatus(byPair, snap, def, firstMs, lastMs) {
  const complete = Object.values(snap.strength).filter((s) => s.complete).length;
  const known = Object.values(snap.pairStates).filter((p) => p.direction !== 0).length;
  const insufficient = Object.values(snap.pairStates).filter((p) => p.reason === 'insufficient-history').length;
  return {
    currenciesComplete: complete, currenciesTotal: 8,
    pairsWithDirection: known, pairsTotal: 28, pairsInsufficientHistory: insufficient,
    firstDataUtc: iso(firstMs), lastDataUtc: iso(lastMs),
    dirTf: def.dirTf, triggerTf: def.triggerTf, alignment: 'EAT (UTC+3, no DST)',
    indexAvailable: snap.dataCompleteness.indexAvailable,
    allComplete: snap.dataCompleteness.complete,
    windows: def.condition ? { fast: def.condition.fastLabel, slow: def.condition.slowLabel, period: def.condition.periodLabel } : null,
  };
}

/** Load H1 (triggers + HTF) and M15 (index) for all pairs; causal when mode === 'historical'. */
async function loadBoth(sb, strategyKey, asOfMs, mode, windowDays) {
  const h1From = asOfMs - (LOOKBACK_DAYS[strategyKey] || 220) * DAY;
  const evoFrom = asOfMs - evoSpanDays(strategyKey, windowDays) * DAY;
  const h1opts = { fromIso: iso(h1From), withVolume: true };
  const m15opts = { fromIso: iso(evoFrom) };
  if (mode === 'historical') { h1opts.toIso = iso(asOfMs); m15opts.toIso = iso(asOfMs); }
  const [byH1, byM15] = await Promise.all([
    loadH1Parallel(sb, PAIRS, h1opts, 8),
    loadM15Parallel(sb, PAIRS, m15opts, 8),
  ]);
  return { byH1, byM15 };
}

/**
 * Full live/replay context for one strategy. Returns the engine context plus the computed
 * snapshot and a recent-signal window — the raw material every view shapes.
 */
async function compute(sb, strategyKey, asOfMs, mode, { paramsOverride, historyDays = 60 } = {}) {
  const prm = paramsOverride ? validParams(paramsOverride) : await activeParams(sb, strategyKey);
  const def = strategyDef(strategyKey, prm);
  const { byH1, byM15 } = await loadBoth(sb, strategyKey, asOfMs, mode, historyDays);
  const lastMs = lastDataMs(byH1), firstMs = firstDataMs(byH1);
  if (!lastMs) return { available: false, reason: 'no-data', def };
  const cutoff = Math.min(asOfMs, lastMs);
  const ctx = buildContext(def, { h1ByPair: byH1, m15ByPair: byM15 });
  const snap = snapshotAt(ctx, cutoff);
  const recent = sweepSignals(ctx, cutoff - historyDays * DAY, cutoff);
  return { available: true, def, ctx, cutoff, snap, recent, lastMs, firstMs, status: dataStatus(byH1, snap, def, firstMs, lastMs), params: prm };
}

/**
 * Build a replay context: load H1 from (atMs − lookback) up to NOW and M15 deep enough for the
 * replay window, so the caller can evaluate causally AT atMs and STEP forward through later
 * closes. `cutoff` is the latest evaluable close (≈ now). Read-only.
 */
async function buildReplayContext(sb, strategyKey, atMs, { paramsOverride, windowDays = 7 } = {}) {
  const prm = paramsOverride ? validParams(paramsOverride) : await activeParams(sb, strategyKey);
  const def = strategyDef(strategyKey, prm);
  const h1From = atMs - (LOOKBACK_DAYS[strategyKey] || 220) * DAY;
  const evoFrom = atMs - evoSpanDays(strategyKey, windowDays) * DAY;
  const [byH1, byM15] = await Promise.all([
    loadH1Parallel(sb, PAIRS, { fromIso: iso(h1From), withVolume: true }, 8),   // …up to now
    loadM15Parallel(sb, PAIRS, { fromIso: iso(evoFrom) }, 8),
  ]);
  const lastMs = lastDataMs(byH1), firstMs = firstDataMs(byH1);
  if (!lastMs) return { available: false, reason: 'no-data', def };
  const ctx = buildContext(def, { h1ByPair: byH1, m15ByPair: byM15 });
  return { available: true, def, ctx, cutoff: lastMs, firstMs, lastMs, params: prm, loadedFromMs: h1From, evoLoadedFromMs: evoFrom };
}

/**
 * Persist signals/pair-states/snapshot over a range, idempotently. Shared by the live cron
 * (forward from the cursor) and the historical backfill (an explicit window). Uses the SAME
 * engine as live/replay, so persisted signals match what the dashboard shows. Deterministic
 * ids make re-runs no-ops. Replay never calls this (it is a pure recompute).
 */
async function persistRange(sb, strategyKey, { origin = 'forward', fromMs = null, toMs = null, advanceCursor = false } = {}) {
  const prm = await activeParams(sb, strategyKey);
  const def = strategyDef(strategyKey, prm);
  await ensureVersion(sb, def);

  const upper = toMs != null ? toMs : Date.now();
  const h1From = upper - (LOOKBACK_DAYS[strategyKey] || 220) * DAY;
  const bufferDays = (SLOW_BUFFER_DAYS[strategyKey] || 2) + (PERIOD_DAYS[strategyKey] || 1) + 1;
  const evoFrom = (fromMs != null && fromMs > 0) ? (fromMs - bufferDays * DAY) : (upper - evoSpanDays(strategyKey, 60) * DAY);
  const [byH1, byM15] = await Promise.all([
    loadH1Parallel(sb, PAIRS, { fromIso: iso(h1From), toIso: iso(upper), withVolume: true }, 8),
    loadM15Parallel(sb, PAIRS, { fromIso: iso(evoFrom), toIso: iso(upper) }, 8),
  ]);
  const lastMs = lastDataMs(byH1);
  if (!lastMs) return { ok: false, reason: 'no-data', strategy: strategyKey };
  const cutoff = Math.min(upper, lastMs);

  const cursor = fromMs != null ? fromMs : await getCursor(sb, strategyKey);
  const ctx = buildContext(def, { h1ByPair: byH1, m15ByPair: byM15 });

  // publish any signals whose trigger candle closed in (cursor, cutoff]
  const sigs = sweepSignals(ctx, cursor, cutoff);
  const published = await putSignals(sb, sigs, origin);

  // refresh the live higher-TF pair states (diagnostic) + decision snapshot at the cutoff
  const snap = snapshotAt(ctx, cutoff);
  await putPairStates(sb, def.dirTf, snap.pairStates);
  await putDecisionSnapshot(sb, def, snap, origin);

  let newCursor = cursor;
  if (advanceCursor) {
    const lastClose = latestTriggerClose(ctx, cutoff);
    if (lastClose != null && lastClose > cursor) { await setCursor(sb, strategyKey, lastClose); newCursor = lastClose; }
    else if (cursor === 0 && lastClose != null) { await setCursor(sb, strategyKey, lastClose); newCursor = lastClose; }
  }

  return {
    ok: true, strategy: strategyKey, origin, version: def.version, params: prm,
    fromMs: cursor, toMs: cutoff, fromUtc: iso(cursor || null), toUtc: iso(cutoff),
    signalsFound: sigs.length, persisted: published, cursorAdvancedTo: advanceCursor ? iso(newCursor) : null,
    lastDataUtc: iso(lastMs),
  };
}

module.exports = { compute, buildReplayContext, persistRange, activeParams, loadBoth, lastDataMs, firstDataMs, dataStatus, strategyDef, STRATEGIES, STRATEGY_KEYS, DEFAULT_PARAMS, DAY, iso, LOOKBACK_DAYS, evoSpanDays };
