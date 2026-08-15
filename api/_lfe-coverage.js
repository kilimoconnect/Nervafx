'use strict';

/**
 * NervaFX Liquidity Failure Engine — data-coverage service.
 *
 * Coverage is DERIVED from the actual `backtest_candles` rows, never hardcoded.
 * The dataset begins 2025-05-19 and is extended hourly; there is no fixed end
 * date. Bounds are recomputed on every request.
 *
 * PostgREST aggregate functions are blocked on this project, so min/max are read
 * with order + limit(1) probes.
 */

const { HOUR_MS, M15_MS, PAIRS, CONFIG } = require('./_lfe-constants');

const toMs = (iso) => (iso == null ? NaN : new Date(iso).getTime());
const toIso = (ms) => new Date(ms).toISOString();

/**
 * Pure reducer: fold per-pair raw OPEN timestamps into the coverage window.
 *
 * @param {object} perPair  { PAIR: { h1Earliest, h1Latest, m15Earliest, m15Latest } } (ISO open times)
 * @param {object} [config] defaults to CONFIG
 */
function computeCoverage(perPair, config) {
  config = config || CONFIG;
  const warnings = [];
  const pairsOut = {};

  let commonEarliestRaw = -Infinity;   // latest of every pair's earliest usable open
  let commonLatestClose = Infinity;    // earliest of every pair's latest complete close
  let freshestLatestClose = -Infinity; // newest close across pairs (lag reference)
  let earliestStartOpen = Infinity;    // oldest start across pairs (history reference)

  for (const pair of Object.keys(perPair)) {
    const b = perPair[pair] || {};
    const h1e = toMs(b.h1Earliest), h1l = toMs(b.h1Latest);
    const m15e = toMs(b.m15Earliest), m15l = toMs(b.m15Latest);
    if (![h1e, h1l, m15e, m15l].every(Number.isFinite)) {
      warnings.push({ pair, type: 'MISSING_DATA' });
      continue;
    }
    const pairEarliest = Math.max(h1e, m15e);                 // both timeframes present
    const pairLatestClose = Math.min(h1l + HOUR_MS, m15l + M15_MS); // both complete
    pairsOut[pair] = { pairEarliest, pairLatestClose };
    if (pairEarliest > commonEarliestRaw) commonEarliestRaw = pairEarliest;
    if (pairLatestClose < commonLatestClose) commonLatestClose = pairLatestClose;
    if (pairLatestClose > freshestLatestClose) freshestLatestClose = pairLatestClose;
    if (pairEarliest < earliestStartOpen) earliestStartOpen = pairEarliest;
  }

  if (!Number.isFinite(commonEarliestRaw) || !Number.isFinite(commonLatestClose)) {
    return { ok: false, reason: 'NO_COVERAGE', warnings };
  }

  const warmupMs = Math.max(config.history.minH1 * HOUR_MS, config.history.minM15 * M15_MS);
  const earliestSelectable = commonEarliestRaw + warmupMs;
  const latestAvailable = Math.floor(commonLatestClose / M15_MS) * M15_MS;

  // Flag pairs behind the freshest pair, or starting later than the oldest
  // (advisory only — measured against the leaders, not the common window).
  for (const pair of Object.keys(pairsOut)) {
    const p = pairsOut[pair];
    if (p.pairLatestClose < freshestLatestClose - M15_MS) warnings.push({ pair, type: 'LAGGING_LATEST' });
    if (p.pairEarliest > earliestStartOpen + M15_MS) warnings.push({ pair, type: 'SHORT_HISTORY' });
  }

  return {
    ok: true,
    commonEarliestRaw,
    commonEarliestRawIso: toIso(commonEarliestRaw),
    earliestSelectable,
    earliestSelectableIso: toIso(earliestSelectable),
    latestAvailable,
    commonLatest: latestAvailable,
    commonLatestIso: toIso(latestAvailable),
    warmupMs,
    warnings,
    perPair: pairsOut,
  };
}

/** One order+limit(1) probe. Returns the open ISO or null. */
async function probeEdge(sb, instrument, timeframe, ascending) {
  const { data, error } = await sb
    .from('backtest_candles')
    .select('time')
    .eq('instrument', instrument)
    .eq('timeframe', timeframe)
    .eq('complete', true)
    .order('time', { ascending })
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0].time : null;
}

/**
 * Read live coverage from the DB for the given pairs (defaults to all 28),
 * then fold via computeCoverage.
 */
async function getCoverage(sb, pairs) {
  const list = pairs && pairs.length ? pairs : PAIRS;
  const perPair = {};
  for (const pair of list) {
    const [h1Earliest, h1Latest, m15Earliest, m15Latest] = await Promise.all([
      probeEdge(sb, pair, 'H1', true),
      probeEdge(sb, pair, 'H1', false),
      probeEdge(sb, pair, 'M15', true),
      probeEdge(sb, pair, 'M15', false),
    ]);
    perPair[pair] = { h1Earliest, h1Latest, m15Earliest, m15Latest };
  }
  return computeCoverage(perPair, CONFIG);
}

module.exports = { computeCoverage, getCoverage, probeEdge };
