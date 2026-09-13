'use strict';

/**
 * M15 Intelligence — pair & currency movement engine (§12).
 *
 * Turns a pair's completed M15 candles into a movement record: direction, net
 * displacement, velocity, acceleration, directional efficiency, consistency,
 * excursion, extension from equilibrium, current structural leg and movement
 * stage. Velocity/acceleration are volatility-normalized (so a naturally fast
 * pair does not look permanently "accelerating"), and STAGE derives from
 * structural events + acceleration + vol-normalized distance — never a candle
 * count (§6, §12). Pure & no-lookahead.
 */

const { CONFIG } = require('./config');
const { alphaFromHalfLife, volatilitySeries, clamp, tanhNorm } = require('./math');
const { detectStructure, EV } = require('./structure');
const { evaluateEquilibrium } = require('./equilibrium');
const { pipSize } = require('./pairs');

const CLASS = {
  BEAR_ACC: 'BEARISH_ACCELERATING', BEAR_STEADY: 'BEARISH_STEADY', BEAR_DEC: 'BEARISH_DECELERATING',
  NEUTRAL: 'NEUTRAL',
  BULL_DEC: 'BULLISH_DECELERATING', BULL_STEADY: 'BULLISH_STEADY', BULL_ACC: 'BULLISH_ACCELERATING',
};
const STAGE = ['FORMING', 'EMERGING', 'ACTIVE', 'DEVELOPED', 'MATURE', 'EXHAUSTING', 'FAILED'];

function evaluateMovement(candles, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const pair = opts.pair || 'EUR_USD';
  if (candles.length < 3) {
    return { pair, direction: 'NEUTRAL', classification: CLASS.NEUTRAL, stage: 'FORMING',
      velocity: 0, acceleration: 0, efficiency: 0, consistency: 0, netDisplacement: 0,
      excursionVol: 0, extensionVol: 0, currentLeg: null, insufficient: true };
  }

  const structure = opts.structure || detectStructure(candles, { pair, cfg, spread: opts.spread || 0 });
  const eq = opts.eq || evaluateEquilibrium(candles, { pair, cfg });
  const vol = volatilitySeries(candles, cfg.volatility.trHalfLifeCandles);
  const n = candles.length;
  const volNow = vol[n - 1] || pipSize(pair);

  // Velocity from fast/slow EWMAs of RAW per-candle Δclose (price units).
  // Acceleration = fast − slow (MACD-style) on the raw series, so it is not
  // cancelled when volatility rises in lockstep with speed. Both are reported in
  // volatility units for cross-pair comparability, but classified on the raw
  // signal against a speed-scaled deadband.
  const aSlow = alphaFromHalfLife(cfg.strength.contribHalfLifeCandles);
  const aFast = alphaFromHalfLife(cfg.strength.accelHalfLifeCandles);
  let velSlowRaw = 0, velFastRaw = 0;
  for (let i = 1; i < n; i++) {
    const step = candles[i].close - candles[i - 1].close;
    velSlowRaw += aSlow * (step - velSlowRaw);
    velFastRaw += aFast * (step - velFastRaw);
  }
  const accelRaw = velFastRaw - velSlowRaw;
  const vel = velSlowRaw / volNow;              // velocity in volatility units
  const accel = accelRaw / volNow;              // acceleration in volatility units

  const leg = structure.current && structure.current.direction !== 'NONE' ? structure.current : null;
  const dirSign = leg ? (leg.direction === 'UP' ? 1 : -1) : 0;

  // Directional efficiency & consistency measured over the CURRENT leg (a
  // structural segment), not a fixed lookback. Falls back to recent structure.
  let efficiency = 0, consistency = 0, netDisplacement = 0, excursionVol = 0;
  if (leg) {
    const startIdx = indexAtOrAfter(candles, leg.pivotMs);
    const endIdx = n - 1;
    if (startIdx != null && endIdx > startIdx) {
      let pathSum = 0, withDir = 0, cnt = 0;
      for (let i = startIdx + 1; i <= endIdx; i++) {
        const d = candles[i].close - candles[i - 1].close;
        pathSum += Math.abs(d);
        if (Math.sign(d) === dirSign) withDir++;
        cnt++;
      }
      netDisplacement = candles[endIdx].close - candles[startIdx].close;
      efficiency = pathSum > 0 ? clamp(Math.abs(netDisplacement) / pathSum, 0, 1) : 0;
      consistency = cnt > 0 ? withDir / cnt : 0;
      excursionVol = volNow > 0 ? Math.abs(leg.extreme - leg.pivot) / volNow : 0;
    }
  }

  const extensionVol = eq ? eq.distanceVol : 0;
  const accelSigned = dirSign * accel;          // >0 ⇒ speeding up along the leg (vol units)
  const classification = classify(dirSign, accel); // accel is vol-normalized
  const stage = classifyStage({ leg, structure, accelSigned, extensionVol, efficiency });

  return {
    pair,
    direction: dirSign > 0 ? 'BULLISH' : dirSign < 0 ? 'BEARISH' : 'NEUTRAL',
    classification,
    stage,
    velocity: vel,
    velocityDir: tanhNorm(vel),                 // squashed −1..1 for display
    acceleration: accel,
    efficiency,
    consistency,
    netDisplacement,
    netDisplacementPips: netDisplacement / pipSize(pair),
    excursionVol,
    extensionVol,
    currentLeg: leg,
    volNow,
  };
}

function classify(dirSign, accelNorm) {
  if (dirSign === 0) return CLASS.NEUTRAL;
  // accelNorm is acceleration in volatility units (Δvelocity per candle ÷ vol).
  // A fixed small deadband separates ACC/STEADY/DEC cleanly across pairs because
  // the signal is already volatility-normalized.
  const band = 0.03;
  const signed = dirSign * accelNorm;        // >0 ⇒ speeding up in the leg direction
  const acc = signed > band ? 'ACC' : signed < -band ? 'DEC' : 'STEADY';
  if (dirSign > 0) return acc === 'ACC' ? CLASS.BULL_ACC : acc === 'DEC' ? CLASS.BULL_DEC : CLASS.BULL_STEADY;
  return acc === 'ACC' ? CLASS.BEAR_ACC : acc === 'DEC' ? CLASS.BEAR_DEC : CLASS.BEAR_STEADY;
}

/**
 * Stage from structural events + acceleration + vol-normalized distance (§12).
 * `accelSigned` > 0 means the leg is still speeding up in its own direction.
 */
function classifyStage({ leg, structure, accelSigned, extensionVol, efficiency }) {
  if (!leg) return 'FORMING';
  const ev = structure.events;
  const lastEv = ev[ev.length - 1];
  if (lastEv && (lastEv.type === EV.UP_FAIL || lastEv.type === EV.DN_FAIL)) return 'FAILED';
  const dist = Math.abs(extensionVol);
  const extensions = leg.extensions || 0;
  const speedingUp = accelSigned > 0.002;
  const slowing = accelSigned < -0.002;
  if (extensions === 0 && dist < 0.8) return 'EMERGING';
  if (speedingUp && dist < 2.5) return 'ACTIVE';
  if (dist >= 3.5 && slowing) return 'EXHAUSTING';
  if (dist >= 2.5) return slowing ? 'MATURE' : 'DEVELOPED';
  return efficiency > 0.5 ? 'DEVELOPED' : 'ACTIVE';
}

/** First candle index whose openMs ≥ ms (no-lookahead safe: past times only). */
function indexAtOrAfter(candles, ms) {
  for (let i = 0; i < candles.length; i++) if (candles[i].openMs >= ms) return i;
  return null;
}

module.exports = { evaluateMovement, CLASS, STAGE };
