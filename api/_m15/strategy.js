'use strict';

/**
 * M15 Intelligence — strategy router, manual-setup builder & system decision
 * (§23, §24, §25).
 *
 * The market state selects at most ONE eligible strategy per pair:
 *   A COMPRESSION_RELEASE, B EARLY_EXPANSION, C FIRST_CONTROLLED_PULLBACK,
 *   D FAILED_EXPANSION_REVERSAL.
 * When a strategy is eligible AND the agreement gates support the direction, a
 * MANUAL setup is built (trigger, entry zone, invalidation, stop, targets, R:R).
 * NOTHING here places or manages an order — the setup is a plan a human executes;
 * a live trigger only raises a MANUAL_*_OPPORTUNITY notification (see triggers.js).
 *
 * Pure & deterministic. `ctx` carries every engine output for the pair plus the
 * agreement result and the primary market state.
 */

const { CONFIG } = require('./config');
const { pipSize } = require('./pairs');

const STRATEGY = {
  A: 'COMPRESSION_RELEASE', B: 'EARLY_EXPANSION',
  C: 'FIRST_CONTROLLED_PULLBACK', D: 'FAILED_EXPANSION_REVERSAL',
};

/** Choose the single controlling strategy, or null. Order encodes precedence. */
function routeStrategy(ctx) {
  const { marketState, compression, pressure, expansion, energy, movement, freshness } = ctx;
  const ms = marketState ? marketState.state : 'TRANSITION';
  const notLate = !freshness || (freshness.state !== 'LATE' && freshness.state !== 'EXHAUSTED');
  const notOver = !expansion || (expansion.state !== 'OVEREXTENDED' && expansion.state !== 'DEVELOPED');

  // D — Failed Expansion Reversal.
  if (/^FAILED_(BULLISH|BEARISH)_EXPANSION$/.test(ms) && notOver) return STRATEGY.D;

  // C — First Controlled Pullback (fresh impulse, first smaller counter-move).
  if (/_(PULLBACK)$/.test(ms) && marketState.pullback && marketState.pullback.isPullback && notLate) return STRATEGY.C;

  // A — Compression Release.
  if ((ms === 'COMPRESSION') && compression && /ACTIVE|TIGHT|RELEASING/.test(compression.state)
      && pressure && /FORMING|BUILDING|DOMINANT/.test(pressure.pressureState)
      && energy && energy.energyAcceleration !== 'FALLING' && notOver) return STRATEGY.A;

  // B — Early Expansion.
  if (/_(EXPANSION)$/.test(ms) && expansion && (expansion.state === 'EARLY' || expansion.state === 'ATTEMPTING' || expansion.state === 'CONFIRMED')
      && expansion.spaceSufficient !== false && notLate && notOver) return STRATEGY.B;

  return null;
}

/**
 * Build a manual setup + system decision from the routed strategy and agreement.
 * Returns { decision, strategy, setup|null }.
 */
function decide(ctx, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const { agreement, marketState, energy, freshness, expansion } = ctx;
  const ms = marketState ? marketState.state : 'TRANSITION';

  // Hard NO-TRADE states first (§25).
  if (ms === 'DEAD') return no('NO_TRADE_DEAD');
  if (ms === 'CHAOTIC') return no('NO_TRADE_CHAOTIC');
  if (agreement && agreement.state === 'CONFLICTED') return no('NO_TRADE_CONFLICTED');
  if (freshness && (freshness.state === 'LATE')) return no('NO_TRADE_LATE');
  if (freshness && (freshness.state === 'EXHAUSTED')) return no('NO_TRADE_LATE');
  if (expansion && expansion.state === 'OVEREXTENDED') return no('NO_TRADE_OVEREXTENDED');
  if (expansion && expansion.spaceSufficient === false) return no('NO_TRADE_INSUFFICIENT_SPACE');
  if (agreement && agreement.gateFailures && agreement.gateFailures.some((x) => /spread/.test(x))) return no('NO_TRADE_SPREAD');

  const strategy = routeStrategy(ctx);
  const agreeDir = agreement && /BULLISH/.test(agreement.state) ? 'BULLISH' : agreement && /BEARISH/.test(agreement.state) ? 'BEARISH' : null;
  const strong = agreement && /^STRONG_/.test(agreement.state);
  const building = agreement && /_BUILDING$/.test(agreement.state);

  // Watch states when structure is forming but agreement not yet actionable.
  if (!strategy || !agreeDir) {
    if (ms === 'COMPRESSION') return watch('WATCH_COMPRESSION', strategy);
    if (/_PRESSURE$/.test(ms)) return watch('WATCH_PRESSURE', strategy);
    return no('NO_TRADE_CONFLICTED', strategy, agreement && agreement.gateFailures);
  }

  // Armed (or opportunity when a strategy + strong/building agreement align).
  if (strong || building) {
    const setup = buildSetup(strategy, agreeDir, ctx, cfg);
    if (!setup) return watch(agreeDir === 'BULLISH' ? 'ARMED_BULLISH' : 'ARMED_BEARISH', strategy);
    return {
      decision: agreeDir === 'BULLISH' ? 'ARMED_BULLISH' : 'ARMED_BEARISH',
      strategy, setup,
      reasons: agreement.reasons,
    };
  }
  // Weak agreement ⇒ watch, not armed.
  return watch(agreeDir === 'BULLISH' ? 'WATCH_PRESSURE' : 'WATCH_PRESSURE', strategy);
}

function no(decision, strategy = null, gateFailures = null) { return { decision, strategy, setup: null, gateFailures }; }
function watch(decision, strategy = null) { return { decision, strategy, setup: null }; }

/**
 * Build the manual setup levels (§24). Trigger is beyond the relevant structural
 * point in the trade direction; stop beyond the invalidation swing; targets at
 * fixed R multiples. All prices are plain numbers a human reads — no orders.
 */
function buildSetup(strategy, dir, ctx, cfg) {
  const { eq, structure, pair } = ctx;
  if (!eq || !structure) return null;
  const t = cfg.trigger;
  const vol = eq.volNow;
  const sign = dir === 'BULLISH' ? 1 : -1;
  const price = eq.price;

  // Reference structural point: the current leg extreme (breakout) or the
  // pullback swing to retest, depending on strategy.
  const cur = structure.current;
  const ref = cur && cur.extreme != null ? cur.extreme : price;
  const trigger = strategy === STRATEGY.C
    ? +(price).toFixed(6)                                   // pullback: act near current price on resumption
    : +(ref + sign * t.entryOffsetVolMult * vol).toFixed(6); // breakout: just beyond the extreme

  const invalidation = cur && cur.pivot != null ? cur.pivot : +(price - sign * 1.5 * vol).toFixed(6);
  const stop = +(invalidation - sign * t.stopBufferVolMult * vol).toFixed(6);
  const risk = Math.abs(trigger - stop);
  if (!(risk > 0)) return null;
  const target1 = +(trigger + sign * t.target1R * risk).toFixed(6);
  const target2 = +(trigger + sign * t.target2R * risk).toFixed(6);
  const ps = pipSize(pair);

  return {
    pair, strategy, direction: dir,
    triggerPrice: trigger,
    entryZoneLow: +Math.min(trigger, +(trigger - sign * t.entryOffsetVolMult * vol).toFixed(6)).toFixed(6),
    entryZoneHigh: +Math.max(trigger, +(trigger - sign * t.entryOffsetVolMult * vol).toFixed(6)).toFixed(6),
    invalidationPrice: invalidation,
    stopPrice: stop,
    stopPips: +(risk / ps).toFixed(1),
    target1, target2,
    rr: cfg.trigger.target2R,
    availableSpaceVol: expansionSpace(ctx),
    freshness: ctx.freshness ? ctx.freshness.state : null,
    expiryCandles: t.expiryCandles,
  };
}

function expansionSpace(ctx) { return ctx.expansion ? ctx.expansion.availableSpaceVol : null; }

module.exports = { routeStrategy, decide, buildSetup, STRATEGY };
