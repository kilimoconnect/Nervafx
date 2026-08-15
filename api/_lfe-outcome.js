'use strict';

/**
 * NervaFX Liquidity Failure Engine — outcome simulation (Portion 8D).
 *
 * Stored SEPARATELY from signal state. Uses future candles ONLY after the signal
 * timestamp, and only here in the outcome processor — never in replay. No broker
 * orders: this is an analytical backtest of a fixed execution model (entry at the
 * next M15 open after confirmation; stop beyond the sweep; default 2R target).
 */

const { M15_MS, CONFIG } = require('./_lfe-constants');

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * @param {object} plan   { direction, entry, stop, target, entryMs }
 * @param {Array}  future candles ascending; only those with openMs ≥ entryMs are used
 * @param {object} opts   { spread, slippage, tfMs, maxHoldCandles }
 */
function simulateOutcome(plan, future, opts) {
  opts = opts || {};
  const spread = opts.spread || 0;
  const slip = opts.slippage || 0;
  const tfMs = opts.tfMs || M15_MS;
  const maxHold = opts.maxHoldCandles || Infinity;
  const isSell = plan.direction === 'SELL';
  const risk = Math.abs(plan.entry - plan.stop);
  if (!(risk > 0)) return { status: 'INVALID', resultR: 0 };

  const effEntry = isSell ? plan.entry - slip : plan.entry + slip;
  let mfe = 0, mae = 0, status = null, exitPrice = null, exitMs = null, held = 0;

  for (const c of future) {
    if (c.openMs < plan.entryMs) continue;
    held += 1;
    const fav = isSell ? effEntry - c.low : c.high - effEntry;
    const adv = isSell ? c.high - effEntry : effEntry - c.low;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;

    const stopHit = isSell ? c.high >= plan.stop : c.low <= plan.stop;
    const tgtHit = isSell ? c.low <= plan.target : c.high >= plan.target;
    if (stopHit) { status = 'LOSS'; exitPrice = plan.stop; exitMs = c.openMs + tfMs; break; } // stop-first (conservative)
    if (tgtHit) { status = 'WIN'; exitPrice = plan.target; exitMs = c.openMs + tfMs; break; }
    if (held >= maxHold) { status = 'EXPIRED'; exitPrice = c.close; exitMs = c.openMs + tfMs; break; }
  }
  if (!status) {
    const last = future.length ? future[future.length - 1] : null;
    status = 'EXPIRED';
    exitPrice = last ? last.close : effEntry;
    exitMs = last ? last.openMs + tfMs : plan.entryMs;
  }

  // Exit fill pays spread + slippage against us.
  const exitFill = isSell ? exitPrice + spread + slip : exitPrice - spread - slip;
  const gross = isSell ? effEntry - exitFill : exitFill - effEntry;

  return {
    status,
    entry: effEntry, stop: plan.stop, target: plan.target,
    exitPrice, exitFill, exitTime: exitMs,
    resultR: round2(gross / risk),
    mfeR: round2(mfe / risk),
    maeR: round2(mae / risk),
    holdingMs: exitMs - plan.entryMs,
    spread, slippage: slip,
    configVersion: (opts.cfg || CONFIG).version,
  };
}

module.exports = { simulateOutcome };
