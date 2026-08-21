'use strict';

/**
 * NervaFX Currency Movement Engine — per-currency movement components (pure).
 *
 * Raw movement / magnitude / breadth / efficiency / persistence / acceleration →
 * Movement Quality → signed Movement Score → state. H1 is the macro baseline;
 * 15M features refine (never override) it.
 */

const { WEIGHTS, ACCEL_BLEND, MAGNITUDE_FULL_SCALE, stateForScore } = require('./_cme-constants');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round = (v) => Math.round(v * 100000) / 100000;
const r1 = (v) => Math.round(v * 10) / 10;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * @param {object} inp
 *   rawMovement:  number  (Σ hourly movement over the window)
 *   hourlySeq:    number[] (this currency's H1 movement per hour)
 *   contribsH1:   number[] (7 signed pair contributions over the window)
 *   micro:        { microPersistence, microAcceleration, microBreadth, path15m }  (optional)
 */
function computeCurrencyComponents(inp) {
  const raw = inp.rawMovement || 0;
  const dir = Math.sign(raw);
  const hourly = inp.hourlySeq || [];
  const contribs = inp.contribsH1 || [];
  const micro = inp.micro || null;

  const magnitude = clamp01(Math.abs(raw) / MAGNITUDE_FULL_SCALE);

  const breadthH1 = contribs.length ? contribs.filter((v) => Math.sign(v) === dir && dir !== 0).length / contribs.length : 0;
  const breadth15M = micro && micro.microBreadth != null ? micro.microBreadth : 0;
  const breadthCombined = micro ? round(0.7 * breadthH1 + 0.3 * breadth15M) : round(breadthH1);

  // Efficiency = |net| / path (H1 path + 0.25 × 15M path for multi-hour windows).
  let path = 0;
  for (const h of hourly) path += Math.abs(h);
  if (micro && micro.path15m) path += 0.25 * micro.path15m;
  const efficiency = clamp01(path > 0 ? Math.abs(raw) / path : (hourly.length ? 0 : 1));

  // Persistence = (directional H1 hours + 15M confirmation) / total hours.
  const dirHours = hourly.filter((h) => Math.sign(h) === dir && dir !== 0).length;
  const microConf = micro && micro.microPersistence != null ? micro.microPersistence : 0;
  const persistence = hourly.length ? clamp01((dirHours + microConf) / (hourly.length + (micro ? 1 : 0))) : 0;

  // Acceleration: macro (late vs early hourly pace) blended with micro.
  const half = Math.floor(hourly.length / 2) || 1;
  const macroAccel = avg(hourly.slice(half)) - avg(hourly.slice(0, half));
  const microAccel = micro && micro.microAcceleration != null ? micro.microAcceleration : 0;
  const combinedAccelRaw = ACCEL_BLEND.h1 * macroAccel + ACCEL_BLEND.m15 * microAccel;
  // Normalise acceleration into [0,1] by whether it reinforces the direction.
  const accelReinforces = dir === 0 ? 0 : clamp01((Math.sign(combinedAccelRaw) === dir ? 1 : 0) * clamp01(Math.abs(combinedAccelRaw) / MAGNITUDE_FULL_SCALE + 0.5));
  const acceleration = accelReinforces;

  const quality = clamp01(
    WEIGHTS.magnitude * magnitude +
    WEIGHTS.breadth * breadthCombined +
    WEIGHTS.efficiency * efficiency +
    WEIGHTS.persistence * persistence +
    WEIGHTS.acceleration * acceleration);

  const movementScore = r1((dir || 0) * quality * 100);
  return {
    rawMovement: round(raw),
    magnitude: round(magnitude),
    breadthH1: round(breadthH1),
    breadth15M: round(breadth15M),
    breadthCombined,
    efficiency: round(efficiency),
    persistence: round(persistence),
    acceleration: round(acceleration),
    macroAcceleration: round(macroAccel),
    microAcceleration: round(microAccel),
    combinedAcceleration: round(combinedAccelRaw),
    movementQuality: round(quality),
    movementScore,
    state: stateForScore(movementScore),
    microState: micro ? micro.microState || null : null,
  };
}

/** Assign 1..8 ranks (1 = strongest movementScore). Mutates and returns the map. */
function assignRanks(byCurrency) {
  const arr = Object.keys(byCurrency).map((c) => ({ c, s: byCurrency[c].movementScore }));
  arr.sort((a, b) => b.s - a.s);
  arr.forEach((x, i) => { byCurrency[x.c].rank = i + 1; });
  return byCurrency;
}

module.exports = { computeCurrencyComponents, assignRanks };
