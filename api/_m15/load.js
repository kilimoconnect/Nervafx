'use strict';

/**
 * M15 Intelligence — synchronized DB loader (§7).
 *
 * Fetches completed M15 candles for all 28 pairs up to a single evaluation
 * frame and returns them time-aligned. No-lookahead: nothing after `evalMs` is
 * ever returned, so live and historical replay use the exact same shape. This is
 * the ONLY place the analytical system reads candles, and it reads M15 only.
 */

const { CONFIG } = require('./config');
const { PAIRS } = require('./pairs');
const { fetchM15, latestCompletedM15Ms, synchronizedTimestamp, M15_MS } = require('./data');

async function loadSynchronized(sb, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const limit = opts.limit || 240;                 // ~2.5 days of M15 for adaptive baselines
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  // Target frame: latest completed M15 for live, or the selected close for replay.
  const evalTarget = opts.atMs != null ? Math.floor(opts.atMs / M15_MS) * M15_MS : latestCompletedM15Ms(nowMs, cfg);

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

module.exports = { loadSynchronized };
