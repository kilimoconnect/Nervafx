'use strict';

/**
 * M15 Intelligence — available-space estimate (§20, §26).
 *
 * Space ahead of price toward the next structural obstacle, in volatility units.
 * Obstacles are prior structural leg extremes standing in the travel direction
 * (a higher up-leg extreme is resistance for a bull; a lower down-leg extreme is
 * support for a bear). If none stands in the way, space is open (capped). Pure.
 */

const { CONFIG } = require('./config');

function availableSpaceVol(structure, price, dirSign, volNow, cfg = CONFIG) {
  if (!structure || !volNow || dirSign === 0) return { spaceVol: cfg.space.openCapVol || 6, barrier: null, sufficient: true };
  const legs = structure.legs || [];
  let barrier = null;
  for (const leg of legs) {
    const extreme = leg.endPrice;
    if (dirSign > 0 && extreme > price) barrier = barrier == null ? extreme : Math.min(barrier, extreme);
    if (dirSign < 0 && extreme < price) barrier = barrier == null ? extreme : Math.max(barrier, extreme);
  }
  const cap = cfg.space.openCapVol || 6;
  if (barrier == null) return { spaceVol: cap, barrier: null, sufficient: true };
  const spaceVol = Math.min(cap, Math.abs(barrier - price) / volNow);
  return { spaceVol: +spaceVol.toFixed(3), barrier, sufficient: spaceVol >= cfg.space.minSpaceVolMult };
}

module.exports = { availableSpaceVol };
