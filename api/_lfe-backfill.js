'use strict';

/**
 * NervaFX Liquidity Failure Engine — chronological historical backfill (Portion 8A).
 *
 * Steps M15 by M15 from earliestSelectable toward commonLatest, evaluating only
 * information available at each moment, persisting new levels/events/transitions/
 * signals idempotently (never duplicating), stamping the config version, and
 * checkpointing so an interrupted run resumes. Dry-run counts without writing.
 * Never erases existing history.
 */

const { HOUR_MS, M15_MS, DAY_MS, FETCH_LIMITS, PAIRS, CONFIG } = require('./_lfe-constants');
const { evaluatePair } = require('./_lfe-scan');

function emptyBuckets() {
  return { confirmed: [], watch: [], pendingDelayed: [], pendingM15: [], accepted: [], expiredInvalidated: [] };
}

/**
 * Build an evaluate(pair, evalMs) that slices pre-fetched full histories in
 * memory instead of re-querying the DB every step. Cursors advance monotonically
 * (the backfill steps chronologically), so the whole walk is amortized O(candles)
 * rather than O(steps × window). The trailing window matches the live fetch caps,
 * so results are identical to the per-step fetch path.
 *
 * @param {object} histories  { pair: { h1:[], m15:[], d1:[] } } ascending, with warm-up
 */
function makeMemoryEvaluate(histories, cfg) {
  cfg = cfg || CONFIG;
  const cursors = {};
  function windowOf(arr, tfMs, evalMs, st, key, limit) {
    let i = st[key];
    while (i + 1 < arr.length && arr[i + 1].openMs + tfMs <= evalMs) i += 1;
    st[key] = i;
    if (i < 0) return [];
    return arr.slice(Math.max(0, i - limit + 1), i + 1);
  }
  return function evaluate(pair, evalMs) {
    const h = histories[pair];
    if (!h) return emptyBuckets();
    if (!cursors[pair]) cursors[pair] = { h1: -1, m15: -1, d1: -1 };
    const st = cursors[pair];
    const h1 = windowOf(h.h1 || [], HOUR_MS, evalMs, st, 'h1', FETCH_LIMITS.h1);
    const m15 = windowOf(h.m15 || [], M15_MS, evalMs, st, 'm15', FETCH_LIMITS.m15);
    const d1 = windowOf(h.d1 || [], DAY_MS, evalMs, st, 'd1', FETCH_LIMITS.d1);
    return evaluatePair(pair, { h1, m15, d1 }, evalMs, { rotation: null }, cfg);
  };
}

/** In-memory idempotent store — the unit-testable reference implementation. */
function createMemoryStore() {
  const levels = new Map();
  const events = new Map();
  const transitions = new Map();
  const signals = new Map();
  return {
    levels, events, transitions, signals,
    saveEvent(e) { const k = e.eventKey; if (events.has(k)) return { created: false }; events.set(k, e); return { created: true }; },
    appendTransition(t) { const k = t.idempotencyKey || `${t.signalKey}|${t.toState}|${t.occurredAt}`; if (transitions.has(k)) return { created: false }; transitions.set(k, t); return { created: true }; },
    upsertSignal(s) { const k = s.signalKey || s.eventKey; const existed = signals.has(k); signals.set(k, s); return { created: !existed }; },
    saveLevel(l) { const k = l.levelKey; if (levels.has(k)) return { created: false }; levels.set(k, l); return { created: true }; },
    counts() { return { levels: levels.size, events: events.size, transitions: transitions.size, signals: signals.size }; },
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Persist the M15-confirmed setups a bucket set produced, deduped by key so each
 * unique setup is written once across the whole run. Pending/accepted/expired
 * events are transient and re-derivable via replay, so they are NOT stored here.
 * The store's per-run seen-set makes re-emissions across steps cheap no-ops.
 */
async function persistBuckets(store, buckets, evalMs, cfg, tally) {
  const signals = [].concat(buckets.confirmed || [], buckets.watch || []);
  const bump = (kind, res) => { if (res && res.created) tally.created[kind] += 1; else tally.dupes[kind] += 1; };

  for (const sig of signals) {
    const ev = sig.event || {};
    bump('events', await store.saveEvent({ eventKey: sig.eventKey, pair: sig.pair, configVersion: cfg.version, firstSeenMs: evalMs, event: ev }));
    for (const t of (ev.transitions || [])) bump('transitions', await store.appendTransition(t));
    bump('signals', await store.upsertSignal({ signalKey: sig.signalKey || sig.eventKey, pair: sig.pair, direction: sig.direction, setupType: sig.setupType, score: sig.score ? sig.score.total : null, state: ev.state, configVersion: cfg.version, firstSeenMs: evalMs, payload: sig }));
  }
}

/**
 * @param {object} opts
 *   evaluate:   async (pair, evalMs) => buckets   (inject; defaults to DB scan)
 *   store:      idempotent store (createMemoryStore or a DB-backed one)
 *   from, to:   UTC ms bounds (from defaults to checkpoint.nextMs)
 *   pairs, batchPairs, stepMs, maxSteps, dryRun, checkpoint, cfg
 */
async function runBackfill(opts) {
  const cfg = opts.cfg || CONFIG;
  const evaluate = opts.evaluate;
  const store = opts.store;
  const pairs = opts.pairs && opts.pairs.length ? opts.pairs : PAIRS;
  const step = opts.stepMs || cfg.backtest.stepMs || M15_MS;
  const batchPairs = opts.batchPairs || cfg.backtest.batchPairs || 7;
  const dryRun = !!opts.dryRun;
  const start = opts.checkpoint && opts.checkpoint.nextMs != null ? opts.checkpoint.nextMs : opts.from;
  const to = opts.to;
  const maxSteps = opts.maxSteps || Infinity;

  const tally = {
    created: { levels: 0, events: 0, transitions: 0, signals: 0 },
    dupes: { levels: 0, events: 0, transitions: 0, signals: 0 },
  };
  const errors = [];
  let ms = start;
  let steps = 0;

  while (ms <= to && steps < maxSteps) {
    for (const batch of chunk(pairs, batchPairs)) {
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(batch.map(async (pair) => {
        try { return { pair, buckets: await evaluate(pair, ms) }; }
        catch (e) { return { pair, error: e.message }; }
      }));
      for (const r of results) {
        if (r.error) { errors.push({ pair: r.pair, ms, error: r.error }); continue; }
        // eslint-disable-next-line no-await-in-loop
        await persistBuckets(store, r.buckets, ms, cfg, tally);
      }
    }
    ms += step;
    steps += 1;
  }

  const done = ms > to;
  return {
    done,
    dryRun,
    configVersion: cfg.version,
    checkpoint: done ? null : { nextMs: ms, configVersion: cfg.version },
    progress: {
      fromMs: start, toMs: to, currentMs: ms, steps,
      pct: to > start ? Math.min(1, Math.round(((ms - start) / (to - start)) * 1000) / 1000) : 1,
    },
    created: tally.created,
    dupes: tally.dupes,
    errors,
  };
}

module.exports = { createMemoryStore, runBackfill, persistBuckets, chunk, makeMemoryEvaluate, emptyBuckets };
