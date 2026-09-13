'use strict';

/**
 * M15 Intelligence — directional-pressure engine (§19).
 *
 * Pressure identifies which side is gaining control BEFORE full expansion, from
 * independent M15 evidence: buying/selling velocity and its acceleration, where
 * price is being accepted relative to equilibrium, which way equilibrium is
 * migrating, and whether recent up-legs are outgrowing down-legs. Each sub-signal
 * is normalized to [−1,1] (positive = bullish); the net is their mean, and
 * buying/selling are the positive/negative masses. Balanced evidence on both
 * sides ⇒ CONFLICTED. Pure & no-lookahead.
 */

const { CONFIG } = require('./config');
const { clamp, tanhNorm, mean } = require('./math');
const { detectStructure } = require('./structure');
const { evaluateEquilibrium } = require('./equilibrium');
const { evaluateMovement } = require('./movement');

function evaluatePressure(candles, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const pair = opts.pair || 'EUR_USD';
  const p = cfg.pressure;
  if (candles.length < 5) return { pair, pressureState: 'BALANCED', netPressure: 0, buyingPressure: 0, sellingPressure: 0, insufficient: true };

  const structure = opts.structure || detectStructure(candles, { pair, cfg, spread: opts.spread || 0 });
  const eq = opts.eq || evaluateEquilibrium(candles, { pair, cfg });
  const movement = opts.movement || evaluateMovement(candles, { pair, cfg, structure, eq });

  const velSig = tanhNorm(movement.velocity);                 // buying vs selling velocity
  const accSig = tanhNorm(movement.acceleration);             // is that velocity accelerating
  const accBias = eq ? eq.acceptanceBias : 0;                 // accepted above/below equilibrium
  const migr = eq ? clamp(eq.migrationVelocity * 8, -1, 1) : 0; // equilibrium migrating up/down
  const legSig = legDominance(structure);                     // up-legs vs down-legs displacement

  const signals = [velSig, accSig, accBias, migr, legSig];
  const net = mean(signals);
  const buying = mean(signals.map((s) => Math.max(0, s)));    // positive mass
  const selling = mean(signals.map((s) => Math.max(0, -s)));  // negative mass

  const pressureState = classify(net, buying, selling, p);
  return {
    pair,
    pressureDirection: net > 0.05 ? 'BULLISH' : net < -0.05 ? 'BEARISH' : 'BALANCED',
    buyingPressure: +buying.toFixed(3),
    sellingPressure: +selling.toFixed(3),
    netPressure: +net.toFixed(3),
    pressureAcceleration: +accSig.toFixed(3),
    pressureState,
    components: { velocity: +velSig.toFixed(3), acceleration: +accSig.toFixed(3), acceptanceBias: +accBias.toFixed(3), migration: +migr.toFixed(3), legDominance: +legSig.toFixed(3) },
  };
}

/** Recent up-leg vs down-leg displacement, normalized to [−1,1]. */
function legDominance(structure) {
  const legs = structure.legs;
  if (!legs.length) return 0;
  let up = 0, dn = 0;
  for (let i = Math.max(0, legs.length - 4); i < legs.length; i++) {
    if (legs[i].direction === 'UP') up += legs[i].displacement;
    else dn += legs[i].displacement;
  }
  const tot = up + dn;
  return tot > 0 ? clamp((up - dn) / tot, -1, 1) : 0;
}

function classify(net, buying, selling, p) {
  // Both sides materially active with little net edge ⇒ conflicted.
  if (buying > 0.25 && selling > 0.25 && Math.abs(net) < p.formingNet) return 'CONFLICTED';
  const a = Math.abs(net);
  if (a < p.formingNet) return 'BALANCED';
  const dir = net > 0 ? 'BULLISH' : 'BEARISH';
  if (a >= p.dominantNet) return `${dir}_DOMINANT`;
  if (a >= p.buildingNet) return `${dir}_BUILDING`;
  return `${dir}_FORMING`;
}

module.exports = { evaluatePressure };
