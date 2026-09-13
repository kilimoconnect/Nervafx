'use strict';

/**
 * M15 Intelligence — primary market-state classifier (§9).
 *
 * Reduces the independent engine outputs to ONE primary M15 state per pair.
 * Precedence runs from "cannot trade" (dead/chaotic/exhausted) down through the
 * structural life-cycle (compression → pressure → expansion → pullback →
 * movement) to BALANCE/TRANSITION. The caller persists the state; this function
 * is a pure snapshot classifier and exposes the evidence behind the choice.
 */

const { CONFIG } = require('./config');

function evaluateMarketState(inputs, opts = {}) {
  const { energy, compression, pressure, expansion, movement, freshness, structure } = inputs;
  const dir = expansion && expansion.direction && expansion.direction !== 'NEUTRAL'
    ? expansion.direction
    : (movement ? movement.direction : 'NEUTRAL');
  const D = dir === 'BULLISH' ? 'BULLISH' : dir === 'BEARISH' ? 'BEARISH' : null;
  const pull = detectPullback(structure);
  const evidence = [];
  const note = (s) => evidence.push(s);

  let state = 'TRANSITION';
  if (energy && energy.energyLevel === 'DEAD') { state = 'DEAD'; note('energy dead'); }
  else if (energy && energy.energyDirection === 'CHAOTIC') { state = 'CHAOTIC'; note('energy chaotic'); }
  else if (D && (expansion?.state === 'OVEREXTENDED' || freshness?.state === 'EXHAUSTED')) { state = `${D}_EXHAUSTION`; note('overextended / exhausted'); }
  else if (D && expansion?.state === 'FAILED') { state = `FAILED_${D}_EXPANSION`; note('expansion failed back inside'); }
  else if (D && pull.isPullback) { state = `${pull.impulseDir}_PULLBACK`; note('counter-move smaller than impulse'); }
  else if (D && (expansion?.state === 'EARLY' || expansion?.state === 'CONFIRMED' || expansion?.state === 'DEVELOPED')) { state = `${D}_EXPANSION`; note(`expansion ${expansion.state}`); }
  else if (compression && (compression.state === 'ACTIVE' || compression.state === 'TIGHT' || compression.state === 'FORMING')) { state = 'COMPRESSION'; note(`compression ${compression.state}`); }
  else if (pressure && /BUILDING|DOMINANT/.test(pressure.pressureState)) { state = `${pressure.pressureDirection}_PRESSURE`; note(`pressure ${pressure.pressureState}`); }
  else if (D && movement && (movement.stage === 'ACTIVE' || movement.stage === 'DEVELOPED' || movement.stage === 'MATURE')) { state = `${D}_MOVEMENT`; note(`movement ${movement.stage}`); }
  else if (compression && compression.state !== 'NONE') { state = 'COMPRESSION'; note('mild compression'); }
  else if (pressure && pressure.pressureState === 'CONFLICTED') { state = 'BALANCE'; note('pressure conflicted'); }
  else if (energy && energy.energyLevel === 'LOW') { state = 'BALANCE'; note('low energy balance'); }
  else { state = 'TRANSITION'; note('no dominant structure'); }

  return { state, direction: D || 'NEUTRAL', pullback: pull, evidence };
}

/** A pullback is a counter-move smaller than the prior impulse leg (§12/§23). */
function detectPullback(structure) {
  const legs = structure && structure.legs ? structure.legs : [];
  const cur = structure && structure.current;
  if (legs.length < 1 || !cur || cur.direction === 'NONE') return { isPullback: false };
  const impulse = legs[legs.length - 1];              // last COMPLETED leg = the impulse
  if (cur.direction === impulse.direction) return { isPullback: false }; // extending, not pulling back
  const counter = cur.displacement || 0;
  if (counter > 0 && counter < impulse.displacement * 0.9) {
    return { isPullback: true, impulseDir: impulse.direction === 'UP' ? 'BULLISH' : 'BEARISH', impulseDisplacement: impulse.displacement, counterDisplacement: counter };
  }
  return { isPullback: false };
}

module.exports = { evaluateMarketState, detectPullback };
