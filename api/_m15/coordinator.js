'use strict';

/**
 * M15 Intelligence — network coordinator (§7, §34).
 *
 * The single orchestrator that turns a synchronized set of completed M15 candles
 * (one ascending array per pair, all ending at the same M15 close) into a full
 * analysis run: per-pair engines, the 28-pair currency network, agreement,
 * market state, strategy decision, optional live-trigger check, and the ranking.
 *
 * Pure and deterministic: given the same candles, evalMs, spreads and config it
 * returns the identical run — so live processing and historical replay share ONE
 * code path (§28, §34). No Date.now(), no DB, no order placement.
 */

const { CONFIG, CONFIG_VERSION, configHash } = require('./config');
const { PAIRS, pipSize, split } = require('./pairs');
const { inputDataHash, idempotencyKey } = require('./data');
const { detectStructure } = require('./structure');
const { evaluateEquilibrium } = require('./equilibrium');
const { evaluateMovement } = require('./movement');
const { evaluateEnergy } = require('./energy');
const { evaluateEMA } = require('./ema');
const { evaluateCompression } = require('./compression');
const { evaluatePressure } = require('./pressure');
const { evaluateExpansion } = require('./expansion');
const { evaluateFreshness } = require('./freshness');
const { evaluateCurrencyStrength, pairSignal, pairStrengthDifferential } = require('./strength');
const { evaluateCurrencyPower } = require('./power');
const { evaluateCurrencyStructure } = require('./currencyStructure');
const { evaluateAgreement } = require('./agreement');
const { evaluateMarketState } = require('./marketState');
const { decide } = require('./strategy');
const { evaluateTrigger } = require('./triggers');
const { rankPairs } = require('./ranking');

function spreadCapPips(pair, cfg) {
  return cfg.spread.maxSpreadPips[pair] || (pair.endsWith('_JPY') ? cfg.spread.maxSpreadPips.JPY : cfg.spread.maxSpreadPips.default);
}

function runNetwork(candlesByPair, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const evalMs = opts.evalMs;
  const spreads = opts.spreads || {};          // pair -> spread in price units
  const prevStates = opts.prevStates || {};    // pair -> previous market state
  const quotes = opts.quotes || {};            // pair -> { bid, ask } (live only)
  const noCriticalNews = opts.noCriticalNews !== false;
  // Reflect the ACTUAL config passed (cfg.version), not the baseline constant, so
  // the published version string is truthful. Baseline cfg.version === CONFIG_VERSION,
  // so the 1.0.0 string (and its idempotency key) is unchanged — Phase 1 reproduces.
  const version = `${cfg.version || CONFIG_VERSION}+${configHash(cfg)}`;

  // ── Pass 1: per-pair engines + strength signals ──────────────────────────
  const perPair = {};
  const movementByPair = {};
  const signalsByPair = {};
  const structureDirs = {};
  for (const pair of PAIRS) {
    const candles = candlesByPair[pair] || [];
    const spread = spreads[pair] || 0;
    const structure = detectStructure(candles, { pair, cfg, spread });
    const eq = evaluateEquilibrium(candles, { pair, cfg });
    const movement = evaluateMovement(candles, { pair, cfg, structure, eq });
    const energy = evaluateEnergy(candles, { pair, cfg, spread });
    const ema = evaluateEMA(candles, { pair, cfg });
    const compression = evaluateCompression(candles, { pair, cfg, spread, structure, eq, movement, ema, prevState: prevStates[pair]?.compression });
    const pressure = evaluatePressure(candles, { pair, cfg, structure, eq, movement });
    const expansion = evaluateExpansion(candles, { pair, cfg, structure, eq, energy, movement });
    const freshness = evaluateFreshness({ eq, energy, expansion, movement, structure }, { cfg });
    perPair[pair] = { structure, eq, movement, energy, ema, compression, pressure, expansion, freshness };
    movementByPair[pair] = movement;
    signalsByPair[pair] = pairSignal(movement);
    structureDirs[pair] = { direction: movement.direction, expansionState: expansion.state, freshness: freshness.state, movementStage: movement.stage };
  }

  // ── Network: strength, power, currency structure ─────────────────────────
  const strength = evaluateCurrencyStrength(signalsByPair, { cfg });
  const power = evaluateCurrencyPower(movementByPair, { cfg, spreads });
  const ccyStructure = evaluateCurrencyStructure(structureDirs, { cfg });

  // ── Pass 2: agreement, market state, decision, trigger ───────────────────
  const pairs = {};
  const rankingInput = [];
  for (const pair of PAIRS) {
    const pp = perPair[pair];
    const { base, quote } = split(pair);
    const spread = spreads[pair] || 0;
    const spreadPips = spread ? spread / pipSize(pair) : 0;
    const capPips = spreadCapPips(pair, cfg);

    const marketState = evaluateMarketState({ ...pp }, { cfg });
    const agreementCtx = {
      pair, movement: pp.movement, ema: pp.ema, pressure: pp.pressure, expansion: pp.expansion,
      energy: pp.energy, eq: pp.eq, freshness: pp.freshness,
      strengthDiff: pairStrengthDifferential(pair, strength.byCurrency),
      baseStrengthAccel: strength.byCurrency[base]?.strengthAcceleration || 0,
      quoteStrengthAccel: strength.byCurrency[quote]?.strengthAcceleration || 0,
      basePower: power.byCurrency[base], quotePower: power.byCurrency[quote],
      baseStructure: ccyStructure.byCurrency[base], quoteStructure: ccyStructure.byCurrency[quote],
      pullbackDeveloping: marketState.pullback && marketState.pullback.isPullback,
      gates: { dataComplete: (candlesByPair[pair] || []).length > cfg.ema.slow + 2, synchronized: true, spreadPips, spreadCapPips: capPips, noCriticalNews },
    };
    const agreement = evaluateAgreement(agreementCtx, { cfg });
    const decision = decide({ ...pp, pair, marketState, agreement }, { cfg });

    let trigger = null;
    if (decision.setup && quotes[pair]) {
      const expiresAtMs = evalMs != null ? evalMs + cfg.trigger.expiryCandles * cfg.processing.m15Ms : null;
      trigger = evaluateTrigger(decision.setup, { ...quotes[pair], timeMs: opts.nowMs }, { expiresAtMs });
    }

    pairs[pair] = {
      pair, marketState, agreement, decision: decision.decision, strategy: decision.strategy,
      setup: decision.setup, trigger,
      strengthDiff: agreementCtx.strengthDiff,
      snapshot: {
        direction: pp.movement.direction, movementStage: pp.movement.stage,
        energyLevel: pp.energy.energyLevel, energyDirection: pp.energy.energyDirection, energyAcceleration: pp.energy.energyAcceleration,
        emaState: pp.ema.state, compression: pp.compression.state, expansion: pp.expansion.state,
        freshness: pp.freshness.state, pressure: pp.pressure.pressureState,
      },
    };
    // Diagnostics (§Phase-1): attach the already-computed engine objects for the
    // gate waterfall. Purely ADDITIVE — never read back into any decision, so a
    // run with diagnostics on is byte-identical in decisions to one with it off.
    if (opts.diagnostics) {
      pairs[pair].diag = { marketState, agreement, expansion: pp.expansion, freshness: pp.freshness, energy: pp.energy, movement: pp.movement, compression: pp.compression, pressure: pp.pressure, eq: pp.eq };
    }
    rankingInput.push({
      pair, agreement, freshness: pp.freshness, expansion: pp.expansion, energy: pp.energy,
      strengthDiff: agreementCtx.strengthDiff, basePower: power.byCurrency[base], quotePower: power.byCurrency[quote],
      marketState, spreadPips, spreadCapPips: capPips, decision: decision.decision, stale: (candlesByPair[pair] || []).length === 0,
    });
  }

  const ranking = rankPairs(rankingInput, { cfg });
  for (const r of ranking) if (pairs[r.pair]) pairs[r.pair].rank = r.rank;

  const inputHash = inputDataHash(candlesByPair, evalMs);
  const run = {
    sourceCandleTimeMs: evalMs,
    calculationVersion: version,
    inputDataHash: inputHash,
    idempotencyKey: idempotencyKey(evalMs, version, inputHash),
    pairsProcessed: PAIRS.length,
    syncState: opts.syncState || 'ALIGNED',
  };

  return { run, pairs, currencies: { strength, power, structure: ccyStructure }, ranking };
}

module.exports = { runNetwork, spreadCapPips };
