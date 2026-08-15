'use strict';

/**
 * NervaFX Liquidity Failure Engine — persistence foundation.
 *
 * Portion 2 establishes only the append-only, idempotent transition primitives
 * (stable keys + point-in-time replay). Full DB read/write wiring lands with the
 * scan/API portion. Nothing here executes broker orders — signals/analysis only.
 */

const { DIRECTION } = require('./_lfe-constants');

/**
 * Stable signal identity. Two evaluations of the same setup yield the same key,
 * so re-running the engine never creates duplicate signals.
 */
function signalKey(pair, direction, levelTimeIso, failureTimeIso) {
  return `${pair}:${direction}:${levelTimeIso}:${failureTimeIso}`;
}

/** Stable transition identity for idempotent, append-only inserts. */
function transitionIdempotencyKey(sigKey, toState, occurredAtIso) {
  return `${sigKey}|${toState}|${occurredAtIso}`;
}

/**
 * Append a transition to an in-memory list if not already present.
 * @returns {{appended:boolean, key:string}}
 */
function appendTransition(list, tx) {
  const key = transitionIdempotencyKey(tx.signalKey, tx.toState, tx.occurredAt);
  for (const t of list) {
    const existing = t.idempotencyKey || transitionIdempotencyKey(t.signalKey, t.toState, t.occurredAt);
    if (existing === key) return { appended: false, key };
  }
  list.push(Object.assign({}, tx, { idempotencyKey: key }));
  return { appended: true, key };
}

/**
 * Replay the state as-it-was-at `evalIso`: the toState of the newest transition
 * whose occurredAt ≤ evalIso. Never looks ahead of the evaluation time.
 */
function stateAt(transitions, evalIso) {
  const evalMs = new Date(evalIso).getTime();
  let best = null;
  let bestMs = -Infinity;
  for (const t of transitions) {
    const ms = new Date(t.occurredAt).getTime();
    if (ms <= evalMs && ms >= bestMs) { bestMs = ms; best = t; }
  }
  return best ? best.toState : null;
}

/**
 * DB-backed idempotent store matching the in-memory interface (createMemoryStore).
 * All writes are additive upserts keyed on the migration's unique constraints, so
 * re-running a backfill never duplicates and never erases existing history.
 */
function createDbStore(sb, cfg) {
  const version = (cfg && cfg.version) || 'lfe-config-v1';
  // Per-run seen-sets: a setup re-emitted at every step is written to the DB only
  // once, collapsing millions of re-emissions into unique upserts.
  const seenE = new Set(), seenT = new Set(), seenS = new Set();
  return {
    async saveEvent(e) {
      if (seenE.has(e.eventKey)) return { created: false };
      seenE.add(e.eventKey);
      const ev = e.event || {};
      const row = {
        event_key: e.eventKey, pair: e.pair, failed_side: ev.failedSide, direction: ev.direction,
        setup_type: ev.setupType, breakout_at: iso(ev.breakoutAtMs), failure_at: iso(ev.failureAtMs),
        attack_at: iso(ev.attackStartMs), config_version: version, metrics: ev,
      };
      const { error } = await sb.from('liquidity_failure_events')
        .upsert(row, { onConflict: 'event_key', ignoreDuplicates: true });
      if (error) throw error;
      return { created: true };
    },
    async appendTransition(t) {
      const key = t.idempotencyKey || transitionIdempotencyKey(t.signalKey, t.toState, t.occurredAt);
      if (seenT.has(key)) return { created: false };
      seenT.add(key);
      const row = {
        signal_key: t.signalKey, from_state: t.fromState || null, to_state: t.toState, reason: t.reason || null,
        occurred_at: t.occurredAt, evaluation_time: t.evaluationTime || t.occurredAt,
        config_version: version, idempotency_key: key,
      };
      const { error } = await sb.from('liquidity_failure_state_transitions')
        .upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true });
      if (error) throw error;
      return { created: true };
    },
    async upsertSignal(s) {
      const key = s.signalKey || s.eventKey;
      if (seenS.has(key)) return { created: false };
      seenS.add(key);
      const row = {
        signal_key: key, pair: s.pair, direction: s.direction, setup_type: s.setupType,
        score: s.score != null ? Math.round(s.score) : null,   // column is integer
        state: s.state, first_seen_at: iso(s.firstSeenMs), updated_at: new Date().toISOString(),
        config_version: version, payload: s.payload || s,
      };
      const { error } = await sb.from('liquidity_failure_signals')
        .upsert(row, { onConflict: 'signal_key', ignoreDuplicates: true });
      if (error) throw error;
      return { created: true };
    },
    async saveLevel() { return { created: true }; }, // levels persisted by the scan path
    counts() { return { events: seenE.size, transitions: seenT.size, signals: seenS.size }; },
  };
}

function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

module.exports = {
  signalKey,
  transitionIdempotencyKey,
  appendTransition,
  stateAt,
  createDbStore,
  // re-exported so persistence callers validate direction without a second import
  DIRECTION,
};
