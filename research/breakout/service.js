'use strict';

/**
 * Service layer for the Breakout API handlers: load H1, build the engine context, and
 * compute live/replay snapshots. Keeps the handlers thin (they only parse the request and
 * shape the response). A small in-memory cache mirrors the Trade Signals pattern.
 */

const { PAIRS, STRATEGIES, STRATEGY_KEYS, DEFAULT_PARAMS, validThreshold, strategyDef, TF } = require('./config');
const { loadH1Parallel } = require('../comparison/dbload');
const { buildContext, snapshotAt } = require('./evaluate');
const { sweepSignals, latestTriggerClose } = require('./replay');
const { ensureVersion, putSignals, putPairStates, putDecisionSnapshot, getCursor, setCursor } = require('./store');

const DAY = 24 * 60 * 60 * 1000;
// How much H1 history to load per strategy so the direction TF has usable depth.
const LOOKBACK_DAYS = { daily: 220, weekly: 430, monthly: 430 };

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** The active strong-threshold for a strategy (stored version, else default). */
async function activeThreshold(sb, strategyKey) {
  try {
    const { data } = await sb.from('breakout_settings_versions')
      .select('params,created_at').eq('strategy_key', strategyKey).eq('active', true)
      .order('created_at', { ascending: false }).limit(1);
    if (data && data[0] && data[0].params && data[0].params.strongThreshold != null) return validThreshold(data[0].params.strongThreshold);
  } catch (_) { /* table may not exist yet → default */ }
  return DEFAULT_PARAMS.strongThreshold;
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

/** Load H1 for all pairs within the strategy lookback (causal when mode === 'historical'). */
async function loadH1(sb, strategyKey, asOfMs, mode) {
  const look = LOOKBACK_DAYS[strategyKey] || 220;
  const fromIso = new Date(asOfMs - look * DAY).toISOString();
  const opts = { fromIso, withVolume: true };
  if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
  return loadH1Parallel(sb, PAIRS, opts, 8);
}

/** Per-currency data completeness (how many of the 8 have all-7 known directions). */
function dataStatus(byPair, snap, def, firstMs, lastMs) {
  const complete = Object.values(snap.strength).filter((s) => s.complete).length;
  const known = Object.values(snap.pairStates).filter((p) => p.direction !== 0).length;
  const insufficient = Object.values(snap.pairStates).filter((p) => p.reason === 'insufficient-history').length;
  return {
    currenciesComplete: complete, currenciesTotal: 8,
    pairsWithDirection: known, pairsTotal: 28, pairsInsufficientHistory: insufficient,
    firstDataUtc: iso(firstMs), lastDataUtc: iso(lastMs),
    dirTf: def.dirTf, triggerTf: def.triggerTf, alignment: 'EAT (UTC+3, no DST)',
    allComplete: snap.dataCompleteness.complete,
  };
}

/**
 * Full live/replay context for one strategy. Returns the engine context plus the computed
 * snapshot and a recent-signal window — the raw material every view shapes.
 */
async function compute(sb, strategyKey, asOfMs, mode, { thresholdOverride, historyDays = 60 } = {}) {
  const thr = thresholdOverride != null ? validThreshold(thresholdOverride) : await activeThreshold(sb, strategyKey);
  const def = strategyDef(strategyKey, { strongThreshold: thr });
  const byPair = await loadH1(sb, strategyKey, asOfMs, mode);
  const lastMs = lastDataMs(byPair), firstMs = firstDataMs(byPair);
  if (!lastMs) return { available: false, reason: 'no-data', def };
  const cutoff = Math.min(asOfMs, lastMs);
  const ctx = buildContext(def, byPair);
  const snap = snapshotAt(ctx, cutoff);
  const recent = sweepSignals(ctx, cutoff - historyDays * DAY, cutoff);
  return { available: true, def, ctx, cutoff, snap, recent, lastMs, firstMs, status: dataStatus(byPair, snap, def, firstMs, lastMs), threshold: thr };
}

/**
 * Build a replay context: load H1 from (atMs − lookback) up to NOW, so the caller can both
 * evaluate causally AT atMs (snapshotAt cuts to T via closeMs ≤ T — no look-ahead) and STEP
 * forward through later completed trigger closes. `cutoff` is the latest evaluable close
 * (≈ now), the upper bound for stepping. Read-only (never writes).
 */
async function buildReplayContext(sb, strategyKey, atMs, { thresholdOverride } = {}) {
  const thr = thresholdOverride != null ? validThreshold(thresholdOverride) : await activeThreshold(sb, strategyKey);
  const def = strategyDef(strategyKey, { strongThreshold: thr });
  const look = LOOKBACK_DAYS[strategyKey] || 220;
  const fromMs = atMs - look * DAY;
  const byPair = await loadH1Parallel(sb, PAIRS, { fromIso: new Date(fromMs).toISOString(), withVolume: true }, 8); // …up to now
  const lastMs = lastDataMs(byPair), firstMs = firstDataMs(byPair);
  if (!lastMs) return { available: false, reason: 'no-data', def };
  const ctx = buildContext(def, byPair);
  return { available: true, def, ctx, cutoff: lastMs, firstMs, lastMs, threshold: thr, loadedFromMs: fromMs };
}

/**
 * Persist signals/pair-states/snapshot over a range, idempotently. Shared by the live cron
 * (forward from the cursor) and the historical backfill (an explicit window). Uses the SAME
 * engine as live/replay, so persisted signals match what the dashboard shows. Deterministic
 * ids make re-runs no-ops. Replay never calls this (it is a pure recompute).
 *
 *   origin        'forward' | 'historical'
 *   fromMs        exclusive lower bound of trigger closes to publish (default: the cursor)
 *   toMs          inclusive upper bound (default: now)
 *   advanceCursor move the per-strategy cursor to the last processed close (cron only)
 */
async function persistRange(sb, strategyKey, { origin = 'forward', fromMs = null, toMs = null, advanceCursor = false } = {}) {
  const thr = await activeThreshold(sb, strategyKey);
  const def = strategyDef(strategyKey, { strongThreshold: thr });
  await ensureVersion(sb, def);

  const upper = toMs != null ? toMs : Date.now();
  const byPair = await loadH1(sb, strategyKey, upper, 'historical');
  const lastMs = lastDataMs(byPair);
  if (!lastMs) return { ok: false, reason: 'no-data', strategy: strategyKey };
  const cutoff = Math.min(upper, lastMs);

  const cursor = fromMs != null ? fromMs : await getCursor(sb, strategyKey);
  const ctx = buildContext(def, byPair);

  // publish any signals whose trigger candle closed in (cursor, cutoff]
  const sigs = sweepSignals(ctx, cursor, cutoff);
  const published = await putSignals(sb, sigs, origin);

  // refresh the live higher-TF pair states + decision snapshot at the cutoff
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
    ok: true, strategy: strategyKey, origin, version: def.version, threshold: thr,
    fromMs: cursor, toMs: cutoff, fromUtc: iso(cursor || null), toUtc: iso(cutoff),
    signalsFound: sigs.length, persisted: published, cursorAdvancedTo: advanceCursor ? iso(newCursor) : null,
    lastDataUtc: iso(lastMs),
  };
}

module.exports = { compute, buildReplayContext, persistRange, activeThreshold, loadH1, lastDataMs, firstDataMs, dataStatus, strategyDef, STRATEGIES, STRATEGY_KEYS, DEFAULT_PARAMS, DAY, iso, LOOKBACK_DAYS };
