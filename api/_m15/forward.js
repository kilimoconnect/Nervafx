'use strict';

/**
 * M15 Intelligence — Phase 4 forward-observation freeze (pure, deterministic).
 *
 * Pins the approved engine/config, the 28-pair universe, the actionable-setup
 * definition, and the observation start for a SHADOW cohort — recorded BEFORE any
 * forward result is examined so the test cannot be moved to fit the data. Also
 * gives every setup episode a STABLE id (repeated ARMED candles are one
 * opportunity) and groups correlated currency-pair episodes so they are not
 * counted as independent evidence.
 *
 * Nothing here executes, sizes, or routes an order. It only labels observations.
 */

const crypto = require('crypto');
const { CONFIG_1_1_0A } = require('./config-1_1_0');
const { configHash } = require('./config');
const { PAIRS, CURRENCIES, split } = require('./pairs');

// The frozen cohort definition. observationStartMs is intentionally null here —
// the OWNER sets it (env M15_SHADOW_START_ISO) at rollout; forward evidence only
// counts episodes whose first close is at/after it. A change to any field below
// requires a NEW version and a NEW cohort (no mid-test edits).
const FORWARD = Object.freeze({
  engineVersion: CONFIG_1_1_0A.version,               // 'm15-cfg-1.1.0a'
  configHash: configHash(CONFIG_1_1_0A),
  fullVersion: `${CONFIG_1_1_0A.version}+${configHash(CONFIG_1_1_0A)}`,
  dataSource: 'OANDA fxpractice · backtest_candles · M15 · MID',
  universe: PAIRS,                                     // exactly 28
  actionableDefinition:
    'ARMED_* or MANUAL_*_OPPORTUNITY with a valid setup (defined entry/stop), all ' +
    'gates passed, on a COMPLETE non-stale snapshot at the live frame. Developing/' +
    'blocked/unavailable are never actionable.',
  observationStartMs: parseStart(process.env.M15_SHADOW_START_ISO),
  observationStartIso: process.env.M15_SHADOW_START_ISO || null,
});

function parseStart(iso) { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? null : t; }

/**
 * Stable episode id: same (pair, direction, first-armed close, version) ⇒ same id
 * across every later ARMED candle of the same run. This is the dedup key for
 * counting opportunities and for notifications.
 */
function episodeId(pair, direction, firstCloseMs, version = FORWARD.fullVersion) {
  return crypto.createHash('sha256')
    .update(`${pair}|${direction}|${firstCloseMs}|${version}`)
    .digest('hex').slice(0, 20);
}

/** Currencies a pair exposes (for correlation grouping). */
function currenciesOf(pair) { const { base, quote } = split(pair); return [base, quote]; }

/**
 * Correlation-aware independence: two episodes overlapping in TIME and sharing a
 * currency are correlated, not independent evidence. Returns each episode tagged
 * with an `independent` flag and the `correlatedWith` ids, greedily keeping the
 * earliest of a correlated cluster as the independent representative.
 * @param episodes [{ id, pair, direction, firstMs, lastMs }...]
 */
function tagIndependence(episodes) {
  const sorted = [...episodes].sort((a, b) => a.firstMs - b.firstMs);
  const kept = [];                                    // representatives held so far
  return sorted.map((e) => {
    const ccy = new Set(currenciesOf(e.pair));
    const clash = kept.filter((k) =>
      k.lastMs >= e.firstMs && k.firstMs <= e.lastMs && // time overlap
      currenciesOf(k.pair).some((c) => ccy.has(c)));    // shared currency
    if (clash.length === 0) { kept.push(e); return { ...e, independent: true, correlatedWith: [] }; }
    return { ...e, independent: false, correlatedWith: clash.map((k) => k.id) };
  });
}

/** Count of independent episodes (correlated ones collapse to their representative). */
function independentCount(episodes) { return tagIndependence(episodes).filter((e) => e.independent).length; }

/** Is an episode inside the frozen forward window? (false when no start is set.) */
function inForwardWindow(firstCloseMs) {
  return FORWARD.observationStartMs != null && firstCloseMs >= FORWARD.observationStartMs;
}

module.exports = { FORWARD, episodeId, currenciesOf, tagIndependence, independentCount, inForwardWindow, CURRENCIES };
