'use strict';

/**
 * M15 Intelligence — equilibrium & acceptance engine (§11).
 *
 * Maintains an ADAPTIVE equilibrium (a slow EWMA of price) and volatility-scaled
 * acceptance boundaries around it. Acceptance above/below is an EWMA bias, not a
 * count of the "last N candles" (§6). Migration velocity measures how fast the
 * equilibrium itself is drifting. Boundaries can be FROZEN for breakout
 * evaluation and, once frozen, are never moved to make a breakout look valid
 * (§11) — freezing returns an immutable record.
 *
 * Pure & no-lookahead: every value at the final index uses only prior candles.
 */

const { CONFIG } = require('./config');
const { ewmaSeries, emaSeries, volatilitySeries, alphaFromHalfLife, clamp } = require('./math');
const { pipSize } = require('./pairs');

function evaluateEquilibrium(candles, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const pair = opts.pair || 'EUR_USD';
  const eqCfg = cfg.equilibrium;
  if (candles.length === 0) return null;

  const closes = candles.map((c) => c.close);
  const eq = ewmaSeries(closes, eqCfg.eqHalfLifeCandles);
  const vol = volatilitySeries(candles, cfg.volatility.trHalfLifeCandles);
  const n = candles.length;
  const last = n - 1;

  const eqNow = eq[last];
  const volNow = vol[last] || pipSize(pair);
  const band = eqCfg.acceptanceVolMultiplier * volNow;
  const upper = eqNow + band;
  const lower = eqNow - band;
  const price = closes[last];

  // Acceptance bias: EWMA of sign(close − eq) ∈ [−1,1]. Adaptive, not windowed.
  const accAlpha = alphaFromHalfLife(cfg.strength.contribHalfLifeCandles);
  let accBias = 0;
  for (let i = 0; i < n; i++) accBias += accAlpha * (Math.sign(closes[i] - eq[i]) - accBias);

  // Equilibrium migration velocity — EWMA of Δeq, normalized by volatility.
  let migr = 0;
  const migrAlpha = alphaFromHalfLife(Math.max(2, eqCfg.migrationNormDivisorCandles / 2));
  for (let i = 1; i < n; i++) migr += migrAlpha * ((eq[i] - eq[i - 1]) - migr);
  const migrationVelVol = volNow > 0 ? migr / volNow : 0; // vol-normalized drift per candle

  const distance = price - eqNow;
  const distanceVol = volNow > 0 ? distance / volNow : 0;

  return {
    pair,
    equilibrium: eqNow,
    upperAcceptance: upper,
    lowerAcceptance: lower,
    band,
    price,
    distance,
    distanceVol,                                   // signed distance in volatility units
    distancePips: distance / pipSize(pair),
    acceptanceAbove: clamp((accBias + 1) / 2, 0, 1),
    acceptanceBelow: clamp((1 - accBias) / 2, 0, 1),
    acceptanceBias: accBias,                       // −1 (below) .. +1 (above)
    migrationDirection: migrationVelVol > 0.02 ? 'UP' : migrationVelVol < -0.02 ? 'DOWN' : 'FLAT',
    migrationVelocity: migrationVelVol,
    withinAcceptance: price <= upper && price >= lower,
    volNow,
    eqSeries: eq,
  };
}

/**
 * Freeze the current acceptance boundary into an immutable record for breakout
 * evaluation (§11). The returned object is frozen; the persistence layer stamps
 * created_at/locked_at/invalidated_at. Never mutate a frozen boundary.
 */
function freezeBoundary(eqSnap, marketState, calcVersion) {
  return Object.freeze({
    boundary_id: `${eqSnap.pair}-${Date.now?.() ?? 0}`, // replaced by DB id on persist
    instrument: eqSnap.pair,
    boundary_type: 'ACCEPTANCE',
    lower_price: eqSnap.lowerAcceptance,
    upper_price: eqSnap.upperAcceptance,
    equilibrium_price: eqSnap.equilibrium,
    market_state: marketState || null,
    calculation_version: calcVersion || CONFIG.version,
    locked: true,
  });
}

/** Explicit EMA20/EMA50 exposed here for reuse (§17 consumes these). */
function emaPair(candles, cfg = CONFIG) {
  const closes = candles.map((c) => c.close);
  return { ema20: emaSeries(closes, cfg.ema.fast), ema50: emaSeries(closes, cfg.ema.slow) };
}

module.exports = { evaluateEquilibrium, freezeBoundary, emaPair };
