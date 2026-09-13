'use strict';

/**
 * M15 Intelligence — expansion engine (§20).
 *
 * Expansion is price separating from equilibrium with increasing directional
 * energy. Measured from: escape beyond the accepted zone, displacement past the
 * adaptive noise threshold, velocity, directional efficiency, volatility
 * expansion, EMA transition, distance from equilibrium and available space.
 *
 * States: NONE / ATTEMPTING / EARLY / CONFIRMED / DEVELOPED / OVEREXTENDED /
 * FAILING / FAILED. The system focuses on ATTEMPTING/EARLY and rejects
 * DEVELOPED/OVEREXTENDED/energy-declining/insufficient-space (§20). Pure &
 * no-lookahead; consumes precomputed eq/energy/movement/structure.
 */

const { CONFIG } = require('./config');
const { evaluateEquilibrium } = require('./equilibrium');
const { evaluateEnergy } = require('./energy');
const { evaluateMovement } = require('./movement');
const { detectStructure } = require('./structure');
const { availableSpaceVol } = require('./space');

function evaluateExpansion(candles, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const pair = opts.pair || 'EUR_USD';
  const x = cfg.expansion;
  if (candles.length < 10) return { pair, state: 'NONE', direction: 'NEUTRAL', insufficient: true };

  const structure = opts.structure || detectStructure(candles, { pair, cfg, spread: opts.spread || 0 });
  const eq = opts.eq || evaluateEquilibrium(candles, { pair, cfg });
  const energy = opts.energy || evaluateEnergy(candles, { pair, cfg, spread: opts.spread || 0 });
  const movement = opts.movement || evaluateMovement(candles, { pair, cfg, structure, eq });

  const distVol = eq.distanceVol;                 // signed distance from equilibrium
  const absDist = Math.abs(distVol);
  const dirSign = Math.sign(distVol);
  const price = candles[candles.length - 1].close;
  const escaped = price > eq.upperAcceptance || price < eq.lowerAcceptance;
  const energyRising = energy.energyAcceleration === 'RISING';
  const energyDeclining = energy.energyAcceleration === 'FALLING';
  const efficient = movement.efficiency >= x.minEfficiency;
  const space = availableSpaceVol(structure, price, dirSign, eq.volNow, cfg);

  let state;
  if (!escaped && absDist < x.escapeVolMult) {
    state = movement.velocity !== 0 && Math.sign(movement.velocity) === dirSign && energyRising ? 'ATTEMPTING' : 'NONE';
  } else if (absDist >= x.overextendedDistVolMult) {
    state = 'OVEREXTENDED';
  } else if (absDist >= x.developedDistVolMult) {
    state = energyDeclining ? 'FAILING' : 'DEVELOPED';
  } else if (escaped && absDist >= x.earlyDistVolMult) {
    // Past the early band: CONFIRMED once efficient, FAILING if energy is rolling
    // over, otherwise still maturing as EARLY (a young leg isn't "efficient" yet).
    state = energyDeclining ? 'FAILING' : (efficient ? 'CONFIRMED' : 'EARLY');
  } else if (escaped) {
    state = energyDeclining ? 'FAILING' : 'EARLY';
  } else {
    state = 'ATTEMPTING';
  }
  // A move that has fallen back inside acceptance after escaping has failed.
  if (!escaped && (opts.prevState === 'EARLY' || opts.prevState === 'CONFIRMED' || opts.prevState === 'ATTEMPTING') && absDist < x.escapeVolMult * 0.5) {
    state = 'FAILED';
  }

  const focus = state === 'ATTEMPTING' || state === 'EARLY';        // system's zone of interest
  const reject = state === 'DEVELOPED' || state === 'OVEREXTENDED' || energyDeclining || !space.sufficient;

  return {
    pair, state,
    direction: dirSign > 0 ? 'BULLISH' : dirSign < 0 ? 'BEARISH' : 'NEUTRAL',
    distanceVol: +distVol.toFixed(3), escaped, efficient, energyRising, energyDeclining,
    availableSpaceVol: space.spaceVol, spaceSufficient: space.sufficient,
    focus, reject,
  };
}

module.exports = { evaluateExpansion };
