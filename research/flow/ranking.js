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
 *   bos         — { PAIR: 'up'|'down' }           H1 break of structure (prior-2-candle range)
 *
 * No orders, no signal — relative-movement research only.
 */

const { PAIRS } = require('../comparison/config');

// Currencies whose Renko index direction contradicts their strength sign (strong-but-falling or
// weak-but-rising) — any pair touching one is dropped, same as the frontend.
function contradictSet(panels) {
  const out = {};
  (panels || []).forEach((p) => {
    if (!p || !p.available || p.lastPp == null || !p.finalDir) return;
    if ((p.lastPp > 0 && p.finalDir === 'down') || (p.lastPp < 0 && p.finalDir === 'up')) out[p.currency] = true;
  });
  return out;
}

// Rank the pairs by the strength gap between their two currencies, after the contradiction filter
// and the same-side filter (one currency genuinely strong, the other genuinely weak). Returns rows
// [{ pair, strong, weak, spread, leanUp, dir, struct, bos }] sorted by spread desc. Not yet
// aligned-filtered — callers decide what to show/alert.
function rankedPairs(panels, structures, bos) {
  structures = structures || {};
  bos = bos || {};
  const strength = {};
  let n = 0;
  (panels || []).forEach((p) => { if (p && p.available && p.lastPp != null) { strength[p.currency] = p.lastPp; n++; } });
  if (n < 2) return [];
  const bad = contradictSet(panels);
  const rows = [];
  PAIRS.forEach((pair) => {
    const pq = pair.split('_'), b = pq[0], q = pq[1];
    if (strength[b] == null || strength[q] == null) return;
    if (bad[b] || bad[q]) return;
    const sb = strength[b], sq = strength[q];
    // one genuinely strong (pp above baseline) vs one genuinely weak (below) — not two of the same side
    if (!((sb > 0 && sq < 0) || (sb < 0 && sq > 0))) return;
    const leanUp = sb >= sq;
    rows.push({
      pair,
      strong: leanUp ? b : q,
      weak: leanUp ? q : b,
      spread: Math.abs(sb - sq),
      leanUp,
      dir: leanUp ? 'up' : 'down',
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

// An H1 break of structure fired in the lean direction.
function hasBos(r) {
  return !!r.bos && r.bos === (r.leanUp ? 'up' : 'down');
}

// The alert trigger set: aligned pairs that also have a trend-direction H1 BoS.
// Returns [{ pair, direction, strong, weak, spread }] sorted by spread desc.
function alertablePairs(panels, structures, bos) {
  return rankedPairs(panels, structures, bos)
    .filter((r) => isAligned(r) && hasBos(r))
    .map((r) => ({ pair: r.pair, direction: r.dir, strong: r.strong, weak: r.weak, spread: r.spread }));
}

module.exports = { contradictSet, rankedPairs, isAligned, hasBos, alertablePairs };
