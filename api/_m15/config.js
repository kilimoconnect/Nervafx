'use strict';

/**
 * M15 Intelligence — versioned configuration (§31).
 *
 * All thresholds live here, never scattered through engine code. Every engine
 * takes `cfg = CONFIG` as an argument so a historical replay can pin an exact
 * version and reproduce results byte-for-byte. Bump CONFIG_VERSION whenever any
 * value changes; never edit a published version's numbers in place — add a new
 * version so old analyses stay reproducible (§27, §28).
 *
 * Design rule (§6): thresholds are expressed as volatility multipliers, EWMA
 * half-lives (in candles, for the *smoothing* of adaptive baselines only) and
 * normalized ratios — NEVER as "look back N candles to define a state". The
 * half-lives configure how fast an adaptive baseline forgets; they do not slice
 * the market into fixed windows.
 */

const crypto = require('crypto');

const CONFIG_VERSION = 'm15-cfg-1.0.0';

const CONFIG = Object.freeze({
  version: CONFIG_VERSION,

  // Grace + freshness of the completed candle (§7).
  processing: {
    graceSecondsAfterClose: 20,     // wait after M15 close before trusting completion
    maxCandleAgeSeconds: 15 * 60 + 180, // one M15 + 3 min: older latest candle ⇒ STALE
    m15Ms: 15 * 60 * 1000,
  },

  // Adaptive volatility baseline (EWMA of true range), expressed as a half-life.
  volatility: {
    trHalfLifeCandles: 24,          // ~6h of M15 — smooth vol baseline, not a window
    fastHalfLifeCandles: 6,         // short-horizon vol for acceleration
    sessionHalfLifeCandles: 96,     // ~1 day — session-relative baseline
    minSamples: 8,                  // need this many TRs before vol is trusted
  },

  // Adaptive directional-change engine (§10). Threshold is a volatility multiple,
  // floored by spread-noise and the instrument minimum.
  directionalChange: {
    volMultiplier: 1.6,             // leg reverses at 1.6× adaptive TR
    spreadNoiseMultiplier: 2.0,     // ≥ 2× current spread
    extendMultiplier: 0.5,          // extension event when leg grows by 0.5× threshold
  },

  // Equilibrium & acceptance (§11).
  equilibrium: {
    eqHalfLifeCandles: 48,          // equilibrium migrates slowly (~12h M15)
    acceptanceVolMultiplier: 1.25,  // acceptance band = eq ± 1.25× adaptive vol
    migrationNormDivisorCandles: 20,// normalizer for migration velocity
  },

  // Market energy (§16) — LEVEL measures capacity to move (direction-agnostic),
  // so it is dominated by absolute volatility LEVEL (in pips), not by directional
  // velocity; a whipsaw is high energy + CHAOTIC direction, not low energy.
  energy: {
    weights: { volatilityLevel: 0.50, range: 0.20, tick: 0.15, body: 0.15 },
    levelPipsLow: 1, levelPipsHigh: 12,   // ramp: vol(pips) → 0..1 volatility-level
    wickPenaltyWeight: 0.5,
    spreadPenaltyWeight: 0.5,
    chaosLevelThreshold: 0.45,            // volatility-level above which low efficiency ⇒ CHAOTIC
    deadBelow: 12, lowBelow: 30, buildingBelow: 45, activeBelow: 62, strongBelow: 80, // 0..100
  },

  // Strength normalization (§13) — scale −100..+100.
  strength: {
    scale: 100,
    contribHalfLifeCandles: 12,     // smoothing of per-pair contribution
    accelHalfLifeCandles: 6,
  },

  // Power & breadth (§14).
  power: {
    weights: { magnitude: 1, breadth: 1, efficiency: 1, persistence: 1, acceleration: 1, liquidity: 1 },
    // Correlation de-duplication: pairs sharing the counter-currency are down-weighted
    // so several correlated readings cannot manufacture false breadth (§14).
    correlationDamp: 0.5,
    buildingBelow: 35, activeBelow: 55, strongBelow: 78, // 0..100 (else EXHAUSTED handled by accel)
  },

  // EMA behaviour (§17) — EMA20/EMA50 only; states, not crossover triggers.
  ema: {
    fast: 20, slow: 50,
    compressedSepVolMult: 0.35,     // |EMA20−EMA50| < 0.35× vol ⇒ compressed
    overextendedDistVolMult: 2.5,   // price > 2.5× vol from EMA20 ⇒ overextended
    slopeEpsilonVolMult: 0.04,      // slope magnitude below this ⇒ flat
  },

  // Compression (§18) — adaptive, never a candle count.
  compression: {
    volContractRatio: 0.75,         // fast vol < 0.75× slow vol baseline
    tightRatio: 0.55,
    effDeclineRatio: 0.9,
    releaseVolExpandRatio: 1.15,
  },

  // Directional pressure (§19).
  pressure: {
    formingNet: 0.15, buildingNet: 0.35, dominantNet: 0.6, // net pressure 0..1
  },

  // Expansion (§20).
  expansion: {
    escapeVolMult: 1.0,             // displacement beyond acceptance by ≥ 1× vol
    earlyDistVolMult: 1.5,
    developedDistVolMult: 2.5,
    overextendedDistVolMult: 3.5,
    minEfficiency: 0.45,
  },

  // Freshness / late-entry rejection (§22).
  freshness: {
    freshMaxDistVolMult: 1.5,
    tradeableMaxDistVolMult: 2.2,
    lateDistVolMult: 3.0,
    exhaustedDistVolMult: 3.8,
    requireRisingEnergyForFresh: true,
  },

  // Spread & tradability gates (§21, §24).
  spread: {
    maxSpreadPips: { default: 2.5, JPY: 3.0, GBP_NZD: 6, GBP_AUD: 5, EUR_NZD: 5 },
  },

  // Available space to the next structural obstacle (§20, §26) as a vol multiple.
  space: {
    minSpaceVolMult: 1.5,
  },

  // Sessions (UTC hours) — for session-relative normalization (§7, §16). Not gates.
  session: {
    tokyo:  [0, 8], london: [7, 16], newYork: [12, 21],
  },

  // Manual trigger behaviour (§24).
  trigger: {
    entryOffsetVolMult: 0.1,
    stopBufferVolMult: 0.6,
    target1R: 1, target2R: 2,
    expiryCandles: 8,               // a setup un-triggered after N M15 closes → EXPIRED
  },

  // Strategy eligibility (§23) — which market states arm which strategy.
  strategy: {
    enabled: ['COMPRESSION_RELEASE', 'EARLY_EXPANSION', 'FIRST_CONTROLLED_PULLBACK', 'FAILED_EXPANSION_REVERSAL'],
  },
});

/** Stable hash of the active config (for reproducibility records, §27). */
function configHash(cfg = CONFIG) {
  return crypto.createHash('sha256').update(stableStringify(cfg)).digest('hex').slice(0, 16);
}

/** Deterministic JSON (sorted keys) so the hash never depends on key order. */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

module.exports = { CONFIG, CONFIG_VERSION, configHash, stableStringify };
