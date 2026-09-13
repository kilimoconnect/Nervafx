'use strict';

/**
 * M15 Intelligence — synchronized DB loader (§7).
 *
 * Fetches completed M15 candles for all 28 pairs up to a single evaluation
 * frame and returns them time-aligned. No-lookahead: nothing after `evalMs` is
 * ever returned, so live and historical replay use the exact same shape. This is
 * the ONLY place the analytical system reads candles, and it reads M15 only.
 *
 * Candle-time convention (verified against OANDA ingestion): `time` is the candle
 * START; a candle opened at t covers [t, t+15m) and CLOSES at t+15m. So at an
 * evaluation instant T the only information that existed is candles with
 * close ≤ T, i.e. open ≤ T − 15m.
 *
 * Replay `atMs` policy (T = the requested evaluation instant, treated as a CLOSE):
 *   frameOpen = floor(T / 15m) · 15m − 15m
 *   = the open of the last candle whose close is ≤ T; nothing opening at or after
 *     that candle's close is included. Off-grid requests snap DOWN to the last
 *     completed close. Boundary test — T = 2026-09-10 12:00 UTC (15:00 EAT): the
 *     candle opening 11:45 (closes 12:00) is included; the one opening 12:00
 *     (closes 12:15) is NOT. `legacyFrame:true` reproduces the pre-fix behaviour
 *     (floor(T)·15m, which wrongly included the candle opening at T) — used ONLY
 *     by the offline diagnostic runner to measure the lookahead impact.
 */

const { CONFIG } = require('./config');
const { PAIRS } = require('./pairs');
const { fetchM15, latestCompletedM15Ms, synchronizedTimestamp, M15_MS } = require('./data');

/** Open-time of the last M15 candle whose close is ≤ T (no candle closing after T). */
function replayFrameOpen(T, legacy) {
  const lastClose = Math.floor(T / M15_MS) * M15_MS;   // last close boundary ≤ T
  return legacy ? lastClose : lastClose - M15_MS;       // fixed: candle that CLOSED at lastClose
}

async function loadSynchronized(sb, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const limit = opts.limit || 240;                 // ~2.5 days of M15 for adaptive baselines
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  // Target frame: latest completed M15 for live, or the selected close for replay.
  const evalTarget = opts.atMs != null
    ? replayFrameOpen(opts.atMs, opts.legacyFrame === true)
    : latestCompletedM15Ms(nowMs, cfg);

  const candlesByPair = {};
  const latestByPair = {};
  await Promise.all(PAIRS.map(async (pair) => {
    const cs = await fetchM15(sb, pair, evalTarget, limit);
    candlesByPair[pair] = cs;
    latestByPair[pair] = cs.length ? cs[cs.length - 1].openMs : null;
  }));

  const sync = synchronizedTimestamp(latestByPair);
  const evalMs = sync.evalMs != null ? sync.evalMs : evalTarget;
  // Truncate every pair to the common synchronized frame (no pair sees further).
  for (const p of PAIRS) candlesByPair[p] = (candlesByPair[p] || []).filter((c) => c.openMs <= evalMs);

  return { evalMs, evalTarget, candlesByPair, sync };
}

module.exports = { loadSynchronized, replayFrameOpen };
