'use strict';

/**
 * M15 Intelligence — currency-strength network engine (§13).
 *
 * Aggregates the whole 28-pair network into a per-currency strength on a
 * −100..+100 scale. Each pair contributes a volatility-NORMALIZED directional
 * signal (so a naturally volatile pair cannot dominate): a positive signal
 * strengthens the base and weakens the quote; negative does the reverse.
 *
 * Level, direction, acceleration, breadth and consistency are kept SEPARATE
 * (§13) — an already-extreme currency whose acceleration is negative is not the
 * same as a freshly strengthening one, and downstream engines must see both.
 *
 * Pure & deterministic. Input is the per-pair signal map produced from the
 * movement engine (see `pairSignal`), so this function has no I/O of its own.
 */

const { CONFIG } = require('./config');
const { CURRENCIES, PAIRS, split, pairsForCurrency } = require('./pairs');
const { clamp, tanhNorm } = require('./math');

/**
 * Bounded directional signal for one pair from its movement record.
 * tanh(velocity) is already volatility-normalized and lives in (−1,1).
 */
function pairSignal(movement) {
  if (!movement) return { strength: 0, acceleration: 0 };
  return {
    strength: clamp(tanhNorm(movement.velocity), -1, 1),
    acceleration: clamp(tanhNorm(movement.acceleration), -1, 1),
  };
}

/**
 * @param {Object<string,{strength:number,acceleration:number}>} signalsByPair
 * @returns {{ byCurrency, ranked }}
 */
function evaluateCurrencyStrength(signalsByPair, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const scale = cfg.strength.scale;

  const byCurrency = {};
  for (const ccy of CURRENCIES) {
    const members = pairsForCurrency(ccy);
    let raw = 0, rawAccel = 0;
    let participating = [], conflicting = [];
    const contribs = [];
    for (const { pair, role } of members) {
      const sig = signalsByPair[pair] || { strength: 0, acceleration: 0 };
      const roleSign = role === 'BASE' ? 1 : -1;
      const contribution = roleSign * sig.strength;         // + ⇒ this currency strengthened
      const accelContribution = roleSign * sig.acceleration;
      raw += contribution;
      rawAccel += accelContribution;
      contribs.push({ pair, role, contribution });
    }
    const n = members.length || 1;
    const score = clamp((raw / n) * scale, -scale, scale);
    const direction = score > 1 ? 'BULLISH' : score < -1 ? 'BEARISH' : 'NEUTRAL';
    const dirSign = Math.sign(score);

    for (const c of contribs) {
      if (dirSign !== 0 && Math.sign(c.contribution) === dirSign && Math.abs(c.contribution) > 1e-9) participating.push(c.pair);
      else if (dirSign !== 0 && Math.sign(c.contribution) === -dirSign && Math.abs(c.contribution) > 1e-9) conflicting.push(c.pair);
    }
    const breadth = participating.length / n;                 // fraction supporting the net direction
    const consistency = 1 - (conflicting.length / n);         // 1 = no pair opposes
    const accel = clamp((rawAccel / n) * scale, -scale, scale);

    byCurrency[ccy] = {
      currency: ccy,
      strengthScore: +score.toFixed(3),
      strengthDirection: direction,
      strengthAcceleration: +accel.toFixed(3),                // SEPARATE from level (§13)
      breadth: +breadth.toFixed(3),
      consistency: +consistency.toFixed(3),
      participatingPairs: participating,
      conflictingPairs: conflicting,
    };
  }

  const ranked = CURRENCIES.slice()
    .sort((a, b) => byCurrency[b].strengthScore - byCurrency[a].strengthScore)
    .map((c, i) => { byCurrency[c].strengthRank = i + 1; return c; });

  return { byCurrency, ranked };
}

/** Strength differential for a pair from a byCurrency map (base − quote). */
function pairStrengthDifferential(pair, byCurrency) {
  const { base, quote } = split(pair);
  return (byCurrency[base]?.strengthScore || 0) - (byCurrency[quote]?.strengthScore || 0);
}

module.exports = { evaluateCurrencyStrength, pairSignal, pairStrengthDifferential, PAIRS };
