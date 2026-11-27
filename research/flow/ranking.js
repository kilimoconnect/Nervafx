'use strict';

/**
 * Shared pair-ranking + alert-trigger logic for the Inverted Flow compare view.
 *
 * This is the single source of truth for which pairs are "aligned with a BoS" — the exact set
 * that renders the ⚡ BoS badge on an aligned pair in public/inverted-flow/flow.js. Both the
 * frontend (buildPairStrength) and the email-alert cron (api/cron-bos-alerts.js) must agree, so
 * the logic lives here and is mirrored by the client renderer.
 *
 * Inputs (as produced by GET /api/inverted-flow?view=compare):
 *   panels      — [{ currency, available, lastPp, finalDir, ... }] per currency index
 *   structures  — { PAIR: 'up'|'down'|'mixed' }  candle structure (EMA20 vs EMA50 on M5 closes)
 *   bos         — { PAIR: 'up'|'down' }           15M BoS: ≥2 of last 3 M15 closes break prior-8 range
 *
 * Direction rule: a currency's buy/sell direction is its CURRENT Renko brick (finalDir) — green/up
 * = buy, red/down = sell. A pair is tradeable only when its two currencies point OPPOSITE ways; the
 * lean is buy-the-pair (up) when the base is green and the quote red, sell (down) when base red and
 * quote green. The pp strength gap (|lastPp difference|) only orders the rows, it no longer decides
 * direction. No orders, no signal — relative-movement research only.
 */

const { PAIRS } = require('../comparison/config');

// Rank the pairs by the strength gap between their two currencies. A pair survives only when its two
// currencies have OPPOSITE current-brick directions (one green/up, one red/down); the lean follows the
// brick (buy the green one, sell the red one). Returns rows [{ pair, strong, weak, spread, leanUp,
// dir, struct, bos }] sorted by spread desc. Not yet aligned-filtered — callers decide what to
// show/alert.
function rankedPairs(panels, structures, bos) {
  structures = structures || {};
  bos = bos || {};
  const strength = {}, dir = {};
  let n = 0;
  (panels || []).forEach((p) => {
    if (!p || !p.available || p.lastPp == null || !p.finalDir) return;
    strength[p.currency] = p.lastPp;   // magnitude only — orders the rows
    dir[p.currency] = p.finalDir;      // current brick = buy (up) / sell (down)
    n++;
  });
  if (n < 2) return [];
  const rows = [];
  PAIRS.forEach((pair) => {
    const pq = pair.split('_'), b = pq[0], q = pq[1];
    if (dir[b] == null || dir[q] == null) return;
    // the two currencies must point opposite ways (one green, one red) — else no clear lean.
    if (dir[b] === dir[q]) return;
    const baseUp = dir[b] === 'up';    // base's brick is green → buy the pair
    rows.push({
      pair,
      strong: baseUp ? b : q,          // the green (bought) currency
      weak: baseUp ? q : b,            // the red (sold) currency
      spread: Math.abs(strength[b] - strength[q]),
      leanUp: baseUp,
      dir: baseUp ? 'up' : 'down',
      struct: structures[pair] || null,
      bos: bos[pair] || null,
    });
  });
  rows.sort((a, b) => b.spread - a.spread);
  return rows;
}

// Candle structure agrees with the strength lean.
function isAligned(r) {
  return (r.struct === 'up' || r.struct === 'down') && ((r.struct === 'up') === r.leanUp);
}

// A 15M break of structure (≥2 of the last 3 M15 breaks) fired in the lean direction.
function hasBos(r) {
  return !!r.bos && r.bos === (r.leanUp ? 'up' : 'down');
}

// The alert trigger set: aligned pairs that also have a trend-direction 15M BoS.
// Returns [{ pair, direction, strong, weak, spread }] sorted by spread desc.
function alertablePairs(panels, structures, bos) {
  return rankedPairs(panels, structures, bos)
    .filter((r) => isAligned(r) && hasBos(r))
    .map((r) => ({ pair: r.pair, direction: r.dir, strong: r.strong, weak: r.weak, spread: r.spread }));
}

module.exports = { rankedPairs, isAligned, hasBos, alertablePairs };
