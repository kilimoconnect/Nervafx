'use strict';

/**
 * M15 Intelligence — data access & integrity layer (§7, §32).
 *
 * Hard rule: this system reads ONLY completed M15 candles. Every DB read here
 * pins `timeframe = 'M15'` and `complete = true`; there is deliberately no code
 * path that queries M1/M5/M30/H1/H4/D1 for analysis. Live bid/ask is handled
 * elsewhere and only for trigger monitoring/spread — never turned into candles.
 *
 * Pure helpers (boundaries, sync, hashing, staleness) are separated from the
 * single thin DB fetch so the whole layer is unit-testable without a database
 * and reused unchanged by live processing and historical replay.
 */

const crypto = require('crypto');
const { CONFIG } = require('./config');
const { PAIRS } = require('./pairs');
const { stableStringify } = require('./config');

const TF = 'M15';
const M15_MS = 15 * 60 * 1000;

/** Guard: refuse any timeframe other than M15 anywhere in the new system. */
function assertM15(timeframe) {
  if (timeframe !== TF) throw new Error(`M15-only system: refused timeframe '${timeframe}'`);
  return TF;
}

/**
 * Open-time label (ms) of the most recently CLOSED, grace-cleared M15 candle.
 * Candles are labelled by open time; a candle opened at T covers [T, T+M15).
 * The candle opened at `boundary − M15` closed at `boundary`; we only trust it
 * once `grace` has elapsed past that close, else we step back one more candle.
 */
function latestCompletedM15Ms(nowMs, cfg = CONFIG) {
  const grace = cfg.processing.graceSecondsAfterClose * 1000;
  let boundary = Math.floor(nowMs / M15_MS) * M15_MS; // close of the just-closed candle
  if (nowMs - boundary < grace) boundary -= M15_MS;   // within grace ⇒ not yet trustable
  return boundary - M15_MS;                           // open-time of that completed candle
}

/** True if the latest candle we hold is too old to act on (§7 reject stale). */
function isStale(latestCandleMs, nowMs, cfg = CONFIG) {
  if (latestCandleMs == null) return true;
  return (nowMs - latestCandleMs) > cfg.processing.maxCandleAgeSeconds * 1000;
}

/**
 * Cross-pair timestamp synchronization (§7). Given the latest completed M15 time
 * each pair reports, return the common timestamp all 28 share, or a rejection if
 * they are not aligned. Strength/power MUST NOT be computed from mismatched times.
 */
function synchronizedTimestamp(latestByPair, pairs = PAIRS) {
  const times = pairs.map((p) => latestByPair[p]);
  if (times.some((t) => t == null)) {
    const missing = pairs.filter((p) => latestByPair[p] == null);
    return { ok: false, reason: 'MISSING_PAIRS', missing, evalMs: null };
  }
  const common = Math.min(...times);
  const laggards = pairs.filter((p) => latestByPair[p] !== common);
  // All aligned → clean. Otherwise the common (oldest) time is the only safe
  // synchronized frame; report the laggards so the run can be flagged, not faked.
  return {
    ok: laggards.length === 0,
    reason: laggards.length === 0 ? 'ALIGNED' : 'MISALIGNED',
    evalMs: common,
    laggards,
  };
}

/** Deterministic hash of the exact candle inputs feeding a run (§27 reproducibility). */
function inputDataHash(candlesByPair, evalMs) {
  const digestOf = (pair) => {
    const cs = candlesByPair[pair] || [];
    const last = cs[cs.length - 1];
    return { pair, n: cs.length, last: last ? [last.openMs ?? last.time, last.open, last.high, last.low, last.close] : null };
  };
  const payload = { evalMs, pairs: PAIRS.map(digestOf) };
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 16);
}

/** Idempotency key for a run: identical (frame, version, inputs) ⇒ identical key (§7). */
function idempotencyKey(evalMs, calculationVersion, inputHash) {
  return crypto.createHash('sha256')
    .update(`${evalMs}|${calculationVersion}|${inputHash}`)
    .digest('hex')
    .slice(0, 24);
}

/** Normalize a raw DB candle row into the engine candle shape. */
function toCandle(row) {
  return {
    openMs: new Date(row.time).getTime(),
    time: row.time,
    open: +row.open, high: +row.high, low: +row.low, close: +row.close,
    volume: row.volume == null ? null : +row.volume,
    complete: row.complete !== false,
  };
}

/**
 * Fetch completed M15 candles for one instrument up to `untilMs` inclusive.
 * No-lookahead: nothing after `untilMs` is ever returned (§28 history mode).
 * `limit` caps how many most-recent candles come back (ordered ascending out).
 */
async function fetchM15(sb, instrument, untilMs, limit = 400) {
  const untilIso = new Date(untilMs).toISOString();
  const { data, error } = await sb
    .from('backtest_candles')
    .select('time,open,high,low,close,volume,complete')
    .eq('instrument', instrument)
    .eq('timeframe', TF)           // ← M15-only, always
    .eq('complete', true)          // ← completed candles only
    .lte('time', untilIso)         // ← no future data
    .order('time', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`fetchM15(${instrument}): ${error.message}`);
  return (data || []).map(toCandle).reverse(); // ascending
}

module.exports = {
  TF, M15_MS, assertM15, latestCompletedM15Ms, isStale,
  synchronizedTimestamp, inputDataHash, idempotencyKey, toCandle, fetchM15,
};
