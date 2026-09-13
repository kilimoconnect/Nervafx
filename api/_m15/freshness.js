'use strict';

/**
 * M15 Intelligence — freshness engine (§22).
 *
 * Prevents late entries. Freshness is about WHERE in the move we are, not how
 * strong it is: high strength, high energy and EMA alignment do NOT imply fresh
 * (§22). A strongly bullish market that is far from equilibrium, decelerating,
 * with many completed cycles is LATE/EXHAUSTED even though every level reads
 * bullish. States: PREPARING / FRESH / TRADEABLE / DEVELOPING / LATE / EXHAUSTED.
 *
 * Pure & no-lookahead; consumes precomputed eq/energy/expansion/movement/
 * structure so it sees exactly what the other engines saw.
 */

const { CONFIG } = require('./config');

function evaluateFreshness(inputs, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const f = cfg.freshness;
  const { eq, energy, expansion, movement, structure } = inputs;
  if (!eq || !expansion) return { state: 'PREPARING', reasons: ['insufficient inputs'] };

  const absDist = Math.abs(eq.distanceVol);
  const dirSign = Math.sign(eq.distanceVol);
  const energyRising = energy && energy.energyAcceleration === 'RISING';
  const energyDeclining = energy && energy.energyAcceleration === 'FALLING';
  // Deceleration along the move's own direction (extreme-but-slowing ⇒ not fresh).
  const decelerating = movement && dirSign !== 0 && Math.sign(movement.acceleration) === -dirSign;
  const cycles = structure ? countCompletedCycles(structure) : 0;
  const reasons = [];

  let state;
  if (expansion.state === 'OVEREXTENDED' || absDist >= f.exhaustedDistVolMult) {
    state = 'EXHAUSTED'; reasons.push('price exhaustively far from equilibrium');
  } else if (absDist >= f.lateDistVolMult || expansion.state === 'DEVELOPED' || (decelerating && absDist >= f.tradeableMaxDistVolMult)) {
    state = 'LATE';
    if (absDist >= f.lateDistVolMult) reasons.push('distance from equilibrium beyond the first-move window');
    if (expansion.state === 'DEVELOPED') reasons.push('expansion already developed');
    if (decelerating) reasons.push('directional acceleration is fading');
  } else if (!expansion.escaped && (expansion.state === 'NONE' || expansion.state === 'ATTEMPTING')) {
    state = 'PREPARING'; reasons.push('not yet escaped the accepted zone');
  } else if (absDist <= f.freshMaxDistVolMult && (!f.requireRisingEnergyForFresh || energyRising) && !decelerating) {
    state = 'FRESH'; reasons.push('early escape, close to equilibrium, energy building');
  } else if (absDist <= f.tradeableMaxDistVolMult && !energyDeclining && !decelerating) {
    state = 'TRADEABLE'; reasons.push('still early enough to act on the first move');
  } else {
    state = 'DEVELOPING'; reasons.push('move maturing — past the freshest window but not yet late');
  }

  return {
    state,
    distanceVol: +absDist.toFixed(3),
    completedCycles: cycles,
    decelerating: !!decelerating,
    energyAcceleration: energy ? energy.energyAcceleration : null,
    firstOpportunityPassed: state === 'LATE' || state === 'EXHAUSTED',
    reasons,
  };
}

/** Completed structural cycles = number of finished legs (event-based, not candles). */
function countCompletedCycles(structure) {
  return structure.legs ? structure.legs.length : 0;
}

module.exports = { evaluateFreshness };
