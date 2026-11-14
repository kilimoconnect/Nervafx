'use strict';

/**
 * Fresh entry-trigger rules (spec §7). The trigger timeframe is the strategy's lower TF
 * (daily→H1, weekly→H4, monthly→D1). A trigger is the SAME break-of-structure definition
 * on the trigger TF: the latest completed trigger candle closing beyond the immediately
 * preceding trigger candle's high (bullish) or low (bearish).
 *
 * A signal is produced only when:
 *   BUY candidate  : a bullish trigger AND, re-checked AT THE TRIGGER CLOSE, base strong & quote weak.
 *   SELL candidate : a bearish trigger AND, re-checked AT THE TRIGGER CLOSE, base weak & quote strong.
 *
 * Also enforced:
 *   - A forming candle cannot generate a signal (callers pass completed candles only).
 *   - A break AGAINST the qualified direction does NOT authorise the opposite trade.
 *   - Qualification is re-checked with the classifications at the trigger candle's close,
 *     never classifications computed later.
 * Duplicate prevention (one signal per distinct trigger candle) is handled by the caller
 * via the deterministic signal id — not here.
 */

const { classifyBreak } = require('./breakout');

/**
 * The break status of the latest completed trigger candle (candle `end-1`) vs its
 * immediate predecessor. `end` lets callers evaluate a causal prefix without copying;
 * omit it to use the last two candles of the whole array.
 * @param candles ascending completed trigger candles.
 */
function triggerBreakUpto(candles, end) {
  const arr = candles || [];
  const n = end == null ? arr.length : Math.max(0, Math.min(end, arr.length));
  if (n < 2) return { break: 0, reason: 'insufficient-history' };
  const c = arr[n - 1], prev = arr[n - 2];
  const cls = classifyBreak(c, prev);
  return {
    break: cls.direction, boundary: cls.boundary, level: cls.level,
    candle: { openMs: c.openMs, closeMs: c.closeMs, open: c.open, high: c.high, low: c.low, close: c.close },
    prev: { openMs: prev.openMs, closeMs: prev.closeMs, high: prev.high, low: prev.low, close: prev.close },
    reason: cls.direction === 0 ? 'no-break' : 'break',
  };
}

/** Break status of the latest completed trigger candle in the whole array. */
function triggerBreak(candles) { return triggerBreakUpto(candles, (candles || []).length); }

/**
 * Decide the final signal for one qualified candidate.
 * @param candidateDir 'BUY' | 'SELL' (from qualification)
 * @param tb           triggerBreak() result
 * @param strengthAtTriggerClose currency-strength map AT the trigger candle's close
 * @param base, quote  the candidate pair's currencies
 * @returns { signal: 'BUY'|'SELL'|null, reason, evaluable: bool }
 */
function decideSignal(candidateDir, tb, strengthAtTriggerClose, base, quote) {
  if (tb.reason === 'insufficient-history') return { signal: null, reason: 'cannot-evaluate:insufficient-history', evaluable: false };

  const sb = strengthAtTriggerClose[base] || {}, sq = strengthAtTriggerClose[quote] || {};
  const cb = sb.classification, cq = sq.classification;
  if (cb === 'insufficient' || cq === 'insufficient' || cb == null || cq == null) {
    return { signal: null, reason: 'cannot-evaluate:incomplete-data', evaluable: false };
  }

  if (tb.break === 0) return { signal: null, reason: 'no-signal:no-breakout', evaluable: true };

  const wantBuy = candidateDir === 'BUY';
  const breakMatches = (wantBuy && tb.break === 1) || (!wantBuy && tb.break === -1);
  if (!breakMatches) return { signal: null, reason: 'no-signal:breakout-against-direction', evaluable: true };

  // qualification re-checked at the trigger close
  const stillQualified = wantBuy ? (cb === 'strong' && cq === 'weak') : (cb === 'weak' && cq === 'strong');
  if (!stillQualified) return { signal: null, reason: 'no-signal:qualification-lost', evaluable: true };

  return { signal: candidateDir, reason: 'signal', evaluable: true };
}

module.exports = { triggerBreak, triggerBreakUpto, decideSignal };
