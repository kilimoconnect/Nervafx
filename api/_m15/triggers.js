'use strict';

/**
 * M15 Intelligence — manual trigger monitor (§24, §25).
 *
 * Given a pre-computed setup and the CURRENT live bid/ask, decides whether the
 * predetermined trigger has been reached. For a BUY the ask price triggers entry;
 * for a SELL the bid price does. Reaching the trigger raises a
 * MANUAL_BUY_OPPORTUNITY / MANUAL_SELL_OPPORTUNITY notification — nothing more.
 *
 * This module contains NO order-placement, position-management, or broker code of
 * any kind. Live prices are used ONLY to monitor the trigger, compute spread and
 * confirm freshness; they are never converted into candles (§2). Pure function.
 */

const { pipSize } = require('./pairs');

function evaluateTrigger(setup, quote, opts = {}) {
  if (!setup) return null;
  const { bid, ask, timeMs } = quote || {};
  if (bid == null || ask == null) return { status: 'PENDING', reason: 'no live quote' };

  const ps = pipSize(setup.pair);
  const spreadPips = +((ask - bid) / ps).toFixed(2);
  const base = { pair: setup.pair, strategy: setup.strategy, direction: setup.direction, spreadPips };

  // Expiry / invalidation take precedence over triggering.
  if (opts.expiresAtMs != null && timeMs != null && timeMs > opts.expiresAtMs) return { ...base, status: 'EXPIRED' };

  if (setup.direction === 'BULLISH') {
    if (bid <= setup.invalidationPrice) return { ...base, status: 'INVALIDATED' };
    if (ask >= setup.triggerPrice) return { ...base, status: 'MANUAL_BUY_OPPORTUNITY', triggerPrice: setup.triggerPrice, at: ask };
  } else if (setup.direction === 'BEARISH') {
    if (ask >= setup.invalidationPrice) return { ...base, status: 'INVALIDATED' };
    if (bid <= setup.triggerPrice) return { ...base, status: 'MANUAL_SELL_OPPORTUNITY', triggerPrice: setup.triggerPrice, at: bid };
  }
  return { ...base, status: 'PENDING' };
  // NOTE: there is intentionally no branch that submits, modifies, or closes an
  // order. The user acts manually; the system only notifies.
}

module.exports = { evaluateTrigger };
