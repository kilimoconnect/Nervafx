'use strict';

/**
 * Supabase-backed signal store (spec §8, §9) — the persistence projection for the shared
 * engine. The `runStrategy` loop calls `has(key)` (sync) and `put(key, sig, trade)` (sync);
 * this store buffers writes so the loop stays synchronous, and the caller awaits `flush()`
 * once per run to persist them.
 *
 * Idempotency / immutability:
 *   - Every signal id is DETERMINISTIC (uuid v5 of its dedup key), so re-running the engine
 *     over the same window never creates a duplicate and never needs a read-back for the id.
 *   - `signals` rows are inserted with ON CONFLICT DO NOTHING — a published record is written
 *     exactly once and never rewritten (immutable).
 *   - `signal_events` are appended with ON CONFLICT DO NOTHING (unique on signal_id+type+at).
 *   - `trade_outcomes` is the MUTABLE projection — upserted so an OPEN trade advances to CLOSED
 *     on a later run without touching the immutable signal.
 *
 * The caller preloads TERMINAL signals (CLOSED/EXPIRED/CANCELLED/UNRESOLVED) into the skip set
 * via `loadTerminal()`, so only not-yet-resolved trades are re-processed each run. That makes
 * lifecycle advance idempotent: an OPEN trade is re-evaluated until it resolves, then skipped.
 */

const crypto = require('crypto');

// Fixed namespace UUID for NervaFX trade-signal ids (random, constant).
const NS = 'a7f3c1e2-9b4d-4f6a-8c21-0d5e7a9b3c46';

function uuidv5(name) {
  const nsBytes = Buffer.from(NS.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(nsBytes).update(name, 'utf8').digest();
  const b = Buffer.from(h.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;   // version 5
  b[8] = (b[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const TERMINAL = new Set(['CLOSED', 'EXPIRED', 'CANCELLED', 'UNRESOLVED']);

function signalRow(id, sig) {
  return {
    id,
    strategy_key: sig.strategyKey,
    version: sig.version,
    origin: sig.origin || 'historical',
    pair: sig.pair,
    direction: sig.direction,
    published_at_ms: sig.publishedAtMs,
    info_cutoff_ms: sig.infoCutoffMs,
    entry_close_ms: sig.entryCloseMs,
    rank: sig.rank,
    period_differential: sig.periodDifferential,
    confirmation: sig.confirmation || {},
    trigger: sig.trigger || {},
    atr: sig.atr,
    reference_entry: sig.referenceEntry,
    max_deviation: sig.maxDeviation,
    fixed_stop: sig.fixedStop,
    indicative_target: sig.indicativeTarget,
    entry_expiry_ms: sig.entryExpiryMs,
    data_flags: { estimatedExecution: true, rangeAtrRatio: sig.rangeAtrRatio },
  };
}

function outcomeRow(id, sig, trade) {
  return {
    signal_id: id,
    strategy_key: sig.strategyKey,
    status: trade.status,
    modelled_fill: trade.modelledFill,
    fill_ms: trade.fillMs,
    initial_stop: trade.initialStop,
    target: trade.target,
    initial_risk: trade.initialRisk,
    exit_price: trade.exitPrice,
    exit_ms: trade.exitMs,
    exit_reason: trade.exitReason,
    costs: trade.costs || {},
    net_pnl_acct: trade.netPnlAcct,
    net_r: trade.netR,
    ambiguity_flag: !!trade.ambiguityFlag,
    data_quality: trade.dataQuality || {},
    updated_at: new Date().toISOString(),
  };
}

function eventRows(id, trade) {
  return (trade.events || []).map((e) => ({
    signal_id: id,
    event_type: e.type,
    at_ms: e.atMs,
    payload: e.payload || {},
  }));
}

/**
 * supabaseStore(sb, { terminalIds }) — a buffering store for runStrategy.
 *   terminalIds: optional Set<uuid> of already-resolved signal ids to skip (preloaded).
 */
function supabaseStore(sb, { terminalIds } = {}) {
  const skip = terminalIds || new Set();
  const buf = [];               // { id, sig, trade }
  const seen = new Set();       // ids buffered this run (avoid dup buffering)

  return {
    uuidFor: (key) => uuidv5(key),
    has(key) { return skip.has(uuidv5(key)); },
    put(key, sig, trade) {
      const id = uuidv5(key);
      if (seen.has(id)) return;
      seen.add(id);
      buf.push({ id, sig, trade });
    },
    buffered() { return buf.length; },
    async flush() {
      if (!buf.length) return { signals: 0, events: 0, outcomes: 0 };
      const sigs = buf.map((x) => signalRow(x.id, x.sig));
      const outs = buf.map((x) => outcomeRow(x.id, x.sig, x.trade));
      const evs = buf.flatMap((x) => eventRows(x.id, x.trade));

      // Immutable insert (never overwrite a published signal).
      for (let i = 0; i < sigs.length; i += 500) {
        const { error } = await sb.from('signals')
          .upsert(sigs.slice(i, i + 500), { onConflict: 'id', ignoreDuplicates: true });
        if (error) throw new Error('signals upsert: ' + error.message);
      }
      // Append-only events.
      for (let i = 0; i < evs.length; i += 500) {
        const { error } = await sb.from('signal_events')
          .upsert(evs.slice(i, i + 500), { onConflict: 'signal_id,event_type,at_ms', ignoreDuplicates: true });
        if (error) throw new Error('signal_events upsert: ' + error.message);
      }
      // Mutable outcome projection (advance OPEN → CLOSED etc.).
      for (let i = 0; i < outs.length; i += 500) {
        const { error } = await sb.from('trade_outcomes')
          .upsert(outs.slice(i, i + 500), { onConflict: 'signal_id' });
        if (error) throw new Error('trade_outcomes upsert: ' + error.message);
      }
      const n = { signals: sigs.length, events: evs.length, outcomes: outs.length };
      buf.length = 0; seen.clear();
      return n;
    },
  };
}

/** Preload the set of already-RESOLVED signal ids for the given strategies (skip set). */
async function loadTerminal(sb, strategyKeys) {
  const ids = new Set();
  const { data, error } = await sb.from('trade_outcomes')
    .select('signal_id,status,strategy_key')
    .in('strategy_key', strategyKeys)
    .in('status', Array.from(TERMINAL));
  if (error) throw new Error('loadTerminal: ' + error.message);
  for (const r of data || []) ids.add(r.signal_id);
  return ids;
}

/** Upsert the frozen params for a strategy version (idempotent; immutable per version). */
async function ensureVersion(sb, def) {
  const { error } = await sb.from('strategy_versions')
    .upsert([{ strategy_key: def.key, version: def.version, params: def.params, active: true }],
      { onConflict: 'strategy_key,version', ignoreDuplicates: true });
  if (error) throw new Error('strategy_versions upsert: ' + error.message);
}

/** Persist one ranking snapshot (all 28) for an evaluation decision point. */
async function putRanking(sb, def, { origin, infoCutoffMs, baselineMs, ranking }) {
  const row = {
    strategy_key: def.key, version: def.version, origin: origin || 'forward',
    info_cutoff_ms: infoCutoffMs, baseline_ms: baselineMs,
    ranks: ranking.map((r) => ({ pair: r.pair, differential: r.differential, bias: r.bias, rank: r.rank })),
  };
  const { error } = await sb.from('signal_rankings')
    .upsert([row], { onConflict: 'strategy_key,version,info_cutoff_ms', ignoreDuplicates: true });
  if (error) throw new Error('signal_rankings upsert: ' + error.message);
}

/** Read / advance the idempotent per-strategy cursor. */
async function getCursor(sb, strategyKey) {
  const { data, error } = await sb.from('signal_engine_cursor')
    .select('last_processed_entry_close_ms').eq('strategy_key', strategyKey).limit(1);
  if (error) throw new Error('getCursor: ' + error.message);
  return (data && data[0]) ? data[0].last_processed_entry_close_ms : 0;
}
async function setCursor(sb, strategyKey, ms) {
  const { error } = await sb.from('signal_engine_cursor')
    .upsert([{ strategy_key: strategyKey, last_processed_entry_close_ms: ms, updated_at: new Date().toISOString() }],
      { onConflict: 'strategy_key' });
  if (error) throw new Error('setCursor: ' + error.message);
}

module.exports = { supabaseStore, loadTerminal, ensureVersion, putRanking, getCursor, setCursor, uuidv5, TERMINAL };
