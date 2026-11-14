'use strict';

/**
 * Supabase persistence for the Breakout module. Mirrors the Trade Signals store:
 *   - every signal id is a DETERMINISTIC uuid v5 of its dedup key
 *     [strategyKey, version, pair, triggerCloseMs] — re-running never duplicates and
 *     needs no read-back for the id;
 *   - `breakout_signals` rows are inserted ON CONFLICT DO NOTHING (immutable once published);
 *   - `breakout_pair_states` and `breakout_decision_snapshots` are upserts (latest state);
 *   - the per-strategy cursor makes forward processing idempotent.
 * Replay NEVER calls these writers — it is a pure recompute.
 */

const crypto = require('crypto');

// Fixed namespace UUID for NervaFX breakout signal ids (random, constant; distinct from signals).
const NS = 'b4e1d7a0-3c92-45f8-9a6b-1e2f3a4b5c6d';

function uuidv5(name) {
  const nsBytes = Buffer.from(NS.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(nsBytes).update(name, 'utf8').digest();
  const b = Buffer.from(h.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;   // version 5
  b[8] = (b[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function signalId(sig) { return uuidv5(sig.dedupKey); }

function signalRow(sig, origin) {
  return {
    id: signalId(sig),
    strategy_key: sig.strategyKey, version: sig.version, origin: origin || 'historical',
    pair: sig.pair, direction: sig.direction, base_ccy: sig.base, quote_ccy: sig.quote,
    dir_tf: sig.dirTf, trigger_tf: sig.triggerTf,
    trigger_open_ms: sig.triggerOpenMs, trigger_close_ms: sig.triggerCloseMs,
    broken_boundary: sig.brokenBoundary, broken_level: sig.brokenLevel, reference_close: sig.referenceClose,
    base_score: sig.baseScore, quote_score: sig.quoteScore,
    strength_snapshot: sig.strengthSnapshot, breakout_detail: sig.breakoutDetail || {}, trigger_detail: sig.triggerDetail || {},
    published_at_ms: sig.publishedAtMs, info_cutoff_ms: sig.infoCutoffMs, settings_version: sig.settingsVersion,
    data_flags: { reconstruction: origin === 'historical' },
  };
}

/** Upsert the frozen params for a strategy version (idempotent; immutable per version). */
async function ensureVersion(sb, def) {
  const { error } = await sb.from('breakout_settings_versions')
    .upsert([{ strategy_key: def.key, version: def.version, params: def.params, active: true }],
      { onConflict: 'strategy_key,version', ignoreDuplicates: true });
  if (error) throw new Error('breakout_settings_versions upsert: ' + error.message);
}

/** Insert signals immutably (ON CONFLICT DO NOTHING via deterministic id). */
async function putSignals(sb, sigs, origin) {
  if (!sigs || !sigs.length) return 0;
  const rows = sigs.map((s) => signalRow(s, origin));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('breakout_signals')
      .upsert(rows.slice(i, i + 500), { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw new Error('breakout_signals upsert: ' + error.message);
  }
  return rows.length;
}

/** Upsert the latest higher-TF pair states (one row per timeframe+pair). */
async function putPairStates(sb, timeframe, pairStates) {
  const rows = Object.values(pairStates).map((p) => ({
    timeframe, pair: p.pair, direction: p.direction,
    break_open_ms: p.breakOpenMs == null ? null : p.breakOpenMs,
    break_close_ms: p.breakCloseMs == null ? null : p.breakCloseMs,
    prev_high: p.prevHigh == null ? null : p.prevHigh, prev_low: p.prevLow == null ? null : p.prevLow,
    broken_boundary: p.brokenBoundary || null, break_ohlc: p.breakOhlc || {},
    last_evaluated_ms: p.lastEvaluatedMs || 0, reason: p.reason || null,
    updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('breakout_pair_states')
      .upsert(rows.slice(i, i + 500), { onConflict: 'timeframe,pair' });
    if (error) throw new Error('breakout_pair_states upsert: ' + error.message);
  }
  return rows.length;
}

/** Persist one all-28 decision snapshot (audit / reproduce). */
async function putDecisionSnapshot(sb, def, snap, origin) {
  const strength = {};
  for (const c of Object.keys(snap.strength)) {
    const s = snap.strength[c];
    strength[c] = { score: s.score, classification: s.classification, bull: s.bull, bear: s.bear, complete: s.complete };
  }
  const ranks = snap.qualification.all.map((p) => ({ pair: p.pair, direction: p.direction, reason: p.reason, baseClass: p.baseClass, quoteClass: p.quoteClass, baseScore: p.baseScore, quoteScore: p.quoteScore }));
  const row = {
    strategy_key: def.key, version: def.version, origin: origin || 'forward',
    info_cutoff_ms: snap.asOfMs, strength, ranks, settings_version: def.version,
  };
  const { error } = await sb.from('breakout_decision_snapshots')
    .upsert([row], { onConflict: 'strategy_key,version,info_cutoff_ms', ignoreDuplicates: true });
  if (error) throw new Error('breakout_decision_snapshots upsert: ' + error.message);
}

/** Read / advance the idempotent per-strategy cursor. */
async function getCursor(sb, strategyKey) {
  const { data, error } = await sb.from('breakout_engine_cursor')
    .select('last_processed_trigger_close_ms').eq('strategy_key', strategyKey).limit(1);
  if (error) throw new Error('getCursor: ' + error.message);
  return (data && data[0]) ? data[0].last_processed_trigger_close_ms : 0;
}
async function setCursor(sb, strategyKey, ms) {
  const { error } = await sb.from('breakout_engine_cursor')
    .upsert([{ strategy_key: strategyKey, last_processed_trigger_close_ms: ms, updated_at: new Date().toISOString() }],
      { onConflict: 'strategy_key' });
  if (error) throw new Error('setCursor: ' + error.message);
}

/** Record a replay run config (isolated audit; never touches live tables). */
async function recordReplayRun(sb, config, createdBy) {
  const { data, error } = await sb.from('breakout_replay_runs')
    .insert([{ config, created_by: createdBy || null }]).select('id').limit(1);
  if (error) throw new Error('breakout_replay_runs insert: ' + error.message);
  return data && data[0] ? data[0].id : null;
}

module.exports = { uuidv5, signalId, signalRow, ensureVersion, putSignals, putPairStates, putDecisionSnapshot, getCursor, setCursor, recordReplayRun, NS };
