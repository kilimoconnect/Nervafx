'use strict';

/**
 * NervaFX Currency Movement Engine — 15M intra-hour features (additive).
 *
 * Refines (never overrides) the H1 macro picture with micro-acceleration,
 * intra-hour persistence and micro-breadth derived from the sequence of 15M
 * currency movements inside a window. Pure.
 */

const { STATES } = require('./_cme-constants');

const round = (v) => Math.round(v * 100000) / 100000;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * @param {number[]} seq  this currency's 15M movement per 15M step (chronological)
 * @param {number}   dir  sign of the H1 (macro) movement (+1/-1/0)
 */
function microFeatures(seq, dir) {
  if (!seq || !seq.length) return { microPersistence: 0, microAcceleration: 0, microState: null, steps: 0 };
  const agree = dir === 0 ? 0 : seq.filter((v) => Math.sign(v) === dir).length;
  const microPersistence = agree / seq.length;
  const half = Math.floor(seq.length / 2) || 1;
  const microAcceleration = avg(seq.slice(half)) - avg(seq.slice(0, half)); // signed change of pace
  let microState = null;
  if (dir > 0) microState = microAcceleration > 0 ? STATES.MICRO_ACCELERATING : STATES.MICRO_DECELERATING;
  else if (dir < 0) microState = microAcceleration < 0 ? STATES.MICRO_ACCELERATING : STATES.MICRO_DECELERATING;
  return { microPersistence: round(microPersistence), microAcceleration: round(microAcceleration), microState, steps: seq.length };
}

/** Micro-breadth: fraction of this currency's 15M pair contributions agreeing with its macro direction. */
function microBreadth(contribs15m, dir) {
  if (!contribs15m || !contribs15m.length || dir === 0) return 0;
  const agree = contribs15m.filter((v) => Math.sign(v) === dir).length;
  return round(agree / contribs15m.length);
}

/** H1 vs 15M divergence: macro up but micro decelerating/against, or vice-versa. */
function microDivergence(dir, micro) {
  if (!micro || dir === 0) return false;
  return micro.microState === STATES.MICRO_DECELERATING && micro.microPersistence < 0.5;
}

module.exports = { microFeatures, microBreadth, microDivergence };
