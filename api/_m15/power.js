'use strict';

/**
 * M15 Intelligence — currency power & breadth engine (§14).
 *
 * Power is NOT strength. Strength is a currency's current relative directional
 * position; power is its ability to produce efficient, broad, persistent and
 * accelerating directional progress. A currency can be extremely strong yet have
 * declining power (over-extended, slowing) — the two are computed and reported
 * independently (§13/§14).
 *
 *   power = geomMean( magnitude, participation, efficiency, acceleration,
 *                     liquidity )                       (each 0..1) × 100
 *
 * Double-counting guard (§14): breadth and per-pair consistency both measure
 * "how much of the network agrees", so they are combined into ONE `participation`
 * factor rather than multiplied as if independent; the weighted GEOMETRIC mean
 * (not a raw product) keeps balanced factors from collapsing and stops several
 * correlated readings from manufacturing artificial agreement.
 *
 * Pure & deterministic. Inputs are per-pair movement records + optional spreads.
 */

const { CONFIG } = require('./config');
const { CURRENCIES, pairsForCurrency, pipSize } = require('./pairs');
const { clamp, tanhNorm, mean } = require('./math');

function geomMeanWeighted(factors, weights) {
  let wsum = 0, acc = 0;
  for (const k of Object.keys(factors)) {
    const w = weights[k] ?? 1;
    const f = clamp(factors[k], 1e-4, 1); // floor avoids log(0)
    acc += w * Math.log(f);
    wsum += w;
  }
  return Math.exp(acc / (wsum || 1));
}

function evaluateCurrencyPower(movementByPair, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const spreads = opts.spreads || {};
  const w = cfg.power.weights;

  const byCurrency = {};
  for (const ccy of CURRENCIES) {
    const members = pairsForCurrency(ccy);
    // Role-adjusted directional signal per pair (+ ⇒ this currency advancing).
    const rows = members.map(({ pair, role }) => {
      const m = movementByPair[pair];
      const roleSign = role === 'BASE' ? 1 : -1;
      const dirSignal = m ? roleSign * tanhNorm(m.velocity) : 0;
      const accSignal = m ? roleSign * tanhNorm(m.acceleration) : 0;
      return { pair, role, dirSignal, accSignal, efficiency: m ? m.efficiency : 0, consistency: m ? m.consistency : 0, spread: spreads[pair] };
    });

    const meanDir = mean(rows.map((r) => r.dirSignal));
    const netSign = Math.sign(meanDir);
    const agreeing = rows.filter((r) => netSign !== 0 && Math.sign(r.dirSignal) === netSign);
    const n = members.length || 1;

    // Factors (each 0..1).
    const magnitude = clamp(Math.abs(meanDir), 0, 1);
    const breadth = agreeing.length / n;
    const meanConsistency = agreeing.length ? mean(agreeing.map((r) => r.consistency)) : 0;
    const participation = clamp(0.5 * breadth + 0.5 * meanConsistency, 0, 1); // merged (anti-double-count)
    const efficiency = agreeing.length ? clamp(mean(agreeing.map((r) => r.efficiency)), 0, 1) : 0;
    const meanAcc = mean(rows.map((r) => r.accSignal));
    const acceleration = clamp(0.5 + 0.5 * (netSign * meanAcc), 0, 1); // 0.5 neutral, ↑ if accelerating along net
    const liquidity = liquidityQuality(rows, ccy, cfg);

    const power01 = geomMeanWeighted({ magnitude, participation, efficiency, acceleration, liquidity }, {
      magnitude: w.magnitude, participation: w.breadth, efficiency: w.efficiency,
      acceleration: w.acceleration, liquidity: w.liquidity,
    });
    const powerScore = +(power01 * 100).toFixed(2);
    const direction = netSign > 0 ? 'BULLISH' : netSign < 0 ? 'BEARISH' : 'NEUTRAL';
    const powerState = classifyPowerState(powerScore, netSign * meanAcc, efficiency, cfg);

    byCurrency[ccy] = {
      currency: ccy, powerScore, powerDirection: direction, powerState,
      factors: {
        magnitude: +magnitude.toFixed(3), participation: +participation.toFixed(3),
        efficiency: +efficiency.toFixed(3), acceleration: +acceleration.toFixed(3), liquidity: +liquidity.toFixed(3),
      },
      breadth: +breadth.toFixed(3),
      supportingPairs: agreeing.map((r) => r.pair),
      conflictingPairs: rows.filter((r) => netSign !== 0 && Math.sign(r.dirSignal) === -netSign).map((r) => r.pair),
    };
  }

  const ranked = CURRENCIES.slice().sort((a, b) => byCurrency[b].powerScore - byCurrency[a].powerScore);
  return { byCurrency, ranked };
}

/** Liquidity quality from spread vs the pair's configured cap (1 = tight, →0 wide). */
function liquidityQuality(rows, ccy, cfg) {
  const qs = rows.map((r) => {
    if (r.spread == null) return 1; // unknown ⇒ do not penalize
    const cap = (cfg.spread.maxSpreadPips[r.pair] || (r.pair.endsWith('_JPY') ? cfg.spread.maxSpreadPips.JPY : cfg.spread.maxSpreadPips.default));
    const spreadPips = r.spread / pipSize(r.pair);
    return clamp(1 - spreadPips / (cap * 2), 0, 1);
  });
  return clamp(mean(qs), 0, 1);
}

function classifyPowerState(score, netAccel, efficiency, cfg) {
  const p = cfg.power;
  if (score >= p.strongBelow && netAccel < -0.05) return 'DECLINING';
  if (score >= p.activeBelow && efficiency < 0.35 && netAccel < 0) return 'EXHAUSTED';
  if (score < p.buildingBelow) return 'BUILDING';
  if (score < p.activeBelow) return 'BUILDING';
  if (score < p.strongBelow) return 'ACTIVE';
  return 'STRONG';
}

module.exports = { evaluateCurrencyPower, geomMeanWeighted };
