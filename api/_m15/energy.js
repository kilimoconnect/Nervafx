'use strict';

/**
 * M15 Intelligence — market-energy engine (§16).
 *
 * Energy = the market's CAPACITY to move. Direction is kept strictly separate.
 * Built from volatility (relative to the pair's own adaptive baseline), price
 * velocity, directional efficiency, candle-body quality, tick activity, with
 * wick and spread penalties. Because every component is an EWMA baseline ratio,
 * a single large candle cannot by itself produce STRONG/EXPLOSIVE energy (§16) —
 * one bar barely moves the baseline.
 *
 * Directional energy is BULLISH/BEARISH only when movement is efficient; high
 * volatility with poor efficiency returns CHAOTIC; little net movement returns
 * BALANCED (§16, §32). Pure & no-lookahead.
 */

const { CONFIG } = require('./config');
const { pipSize } = require('./pairs');
const {
  trueRange, ewmaSeries, volatilitySeries, alphaFromHalfLife, clamp, ramp, mean,
} = require('./math');

function evaluateEnergy(candles, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const pair = opts.pair || 'EUR_USD';
  const spread = opts.spread || 0;
  const e = cfg.energy;
  const n = candles.length;
  if (n < 5) return { pair, energyScore: 0, energyLevel: 'DEAD', energyDirection: 'BALANCED', energyAcceleration: 'STABLE', insufficient: true };

  // Robust volatility & velocity: each candle's TR and Δclose are winsorized
  // against the running slow baseline (cap = 4×), so a SINGLE outsized candle
  // cannot dominate — only sustained expansion (many candles) raises energy (§16).
  const volSlowArr = volatilitySeries(candles, cfg.volatility.sessionHalfLifeCandles);
  const volSlow = volSlowArr[n - 1] || pipSize(pair);
  const aMed = alphaFromHalfLife(cfg.volatility.trHalfLifeCandles);
  const aSlow = alphaFromHalfLife(cfg.volatility.sessionHalfLifeCandles);
  const CAP = 4;
  let volMed = null, slow = null, velFast = 0, pathEwma = 0;
  for (let i = 1; i < n; i++) {
    const tr = trueRange(candles[i], candles[i - 1]);
    const step = candles[i].close - candles[i - 1].close;
    const baseline = slow == null ? Math.max(tr, pipSize(pair)) : slow;
    const capAbs = CAP * baseline;
    const trC = Math.min(tr, capAbs);
    const stepC = clamp(step, -capAbs, capAbs);
    volMed = volMed == null ? trC : volMed + aMed * (trC - volMed);
    slow = slow == null ? tr : slow + aSlow * (tr - slow);
    velFast += aMed * (stepC - velFast);
    pathEwma += aMed * (Math.abs(stepC) - pathEwma);
  }
  const volFast = volMed || pipSize(pair);
  const efficiency = pathEwma > 0 ? clamp(Math.abs(velFast) / pathEwma, 0, 1) : 0;

  // Candle-body quality and tick activity (EWMA, adaptive baselines).
  const bodyFrac = candles.map((c) => { const rng = c.high - c.low; return rng > 0 ? Math.abs(c.close - c.open) / rng : 0; });
  const body = clamp(ewmaSeries(bodyFrac, cfg.volatility.fastHalfLifeCandles)[n - 1], 0, 1);

  const vols = candles.map((c) => (c.volume == null ? null : c.volume));
  const hasVol = vols.some((v) => v != null);
  let tickComp = 0.5;
  if (hasVol) {
    const filled = vols.map((v) => v == null ? 0 : v);
    const fast = ewmaSeries(filled, cfg.volatility.fastHalfLifeCandles)[n - 1];
    const slow = ewmaSeries(filled, cfg.volatility.sessionHalfLifeCandles)[n - 1] || 1;
    tickComp = clamp(ramp(fast / slow, 0.5, 2.0), 0, 1);
  }

  // Range expansion relative to baseline.
  const trNow = trueRange(candles[n - 1], candles[n - 2]);
  const rangeExpansion = volSlow > 0 ? trNow / volSlow : 1;

  // Energy LEVEL components (each 0..1) — direction-agnostic capacity to move.
  // Volatility LEVEL (absolute, in pips) dominates so a whipsaw reads as high
  // energy; directional velocity/efficiency do NOT feed the level (they classify
  // direction only), which is what makes "high energy + low power = chaotic".
  const volLevelPips = volFast / pipSize(pair);
  const volatilityLevel = clamp(ramp(volLevelPips, e.levelPipsLow, e.levelPipsHigh), 0, 1);
  const rangeComp = clamp(ramp(rangeExpansion, 0.8, 2.5), 0, 1);
  const comp = { volatilityLevel, range: rangeComp, tick: tickComp, body };

  let blend = 0;
  for (const k of Object.keys(e.weights)) blend += e.weights[k] * comp[k];

  // Penalties: wick (low body) and spread.
  const wickFactor = 1 - e.wickPenaltyWeight * (1 - body) * 0.5;
  const spreadPips = spread / pipSize(pair);
  const cap = pair.endsWith('_JPY') ? cfg.spread.maxSpreadPips.JPY : cfg.spread.maxSpreadPips.default;
  const spreadFactor = 1 - clamp((spreadPips / cap), 0, 1) * e.spreadPenaltyWeight * 0.5;
  const energy01 = clamp(blend * wickFactor * spreadFactor, 0, 1);
  const energyScore = +(energy01 * 100).toFixed(2);

  const energyLevel = classifyLevel(energyScore, e);
  const energyDirection = classifyDirection(velFast, efficiency, volatilityLevel, volSlow, e);
  const energyAcceleration = volFast > volSlow * cfg.compression.releaseVolExpandRatio ? 'RISING'
    : volFast < volSlow * cfg.compression.volContractRatio ? 'FALLING' : 'STABLE';

  return {
    pair, energyScore, energyLevel, energyDirection, energyAcceleration,
    components: {
      volatilityLevel: +volatilityLevel.toFixed(3), range: +rangeComp.toFixed(3),
      tick: +tickComp.toFixed(3), body: +body.toFixed(3),
      efficiency: +efficiency.toFixed(3), velocity: +(velFast / (volSlow || 1)).toFixed(3),
    },
    volFast, volSlow,
  };
}

function classifyLevel(score, e) {
  if (score < e.deadBelow) return 'DEAD';
  if (score < e.lowBelow) return 'LOW';
  if (score < e.buildingBelow) return 'BUILDING';
  if (score < e.activeBelow) return 'ACTIVE';
  if (score < e.strongBelow) return 'STRONG';
  return 'EXPLOSIVE';
}

/** Direction is BULLISH/BEARISH only when efficient; else CHAOTIC or BALANCED. */
function classifyDirection(velFast, efficiency, volatilityLevel, volSlow, e) {
  // High absolute volatility with poor efficiency is chaotic whipsaw, regardless
  // of net velocity (which averages toward zero in a whipsaw) (§16, §32).
  if (volatilityLevel > e.chaosLevelThreshold && efficiency < 0.35) return 'CHAOTIC';
  const moving = Math.abs(velFast) > 0.15 * volSlow;
  if (!moving) return 'BALANCED';
  if (efficiency < 0.35) return 'BALANCED';
  return velFast > 0 ? 'BULLISH' : 'BEARISH';
}

module.exports = { evaluateEnergy };
