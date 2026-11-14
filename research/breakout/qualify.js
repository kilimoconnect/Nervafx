'use strict';

/**
 * Pair qualification from currency classifications (spec §6). Evaluate ALL 28 pairs:
 *
 *   base Strong + quote Weak   → BUY candidate
 *   base Weak   + quote Strong → SELL candidate
 *   Strong + Strong            → exclude
 *   Weak + Weak                → exclude
 *   Neutral / insufficient any → exclude
 *
 * Neither currency in a qualified pair may be neutral. A qualified pair is a CANDIDATE
 * awaiting a trigger, not an entry signal. Every qualified pair is returned (no top-N).
 */

const { PAIRS } = require('./config');

function reasonFor(cb, cq) {
  if (cb === 'insufficient' && cq === 'insufficient') return 'both-insufficient';
  if (cb === 'insufficient') return 'base-insufficient';
  if (cq === 'insufficient') return 'quote-insufficient';
  if (cb === 'strong' && cq === 'strong') return 'both-strong';
  if (cb === 'weak' && cq === 'weak') return 'both-weak';
  if (cb === 'neutral' || cq === 'neutral') return 'neutral-leg';
  return 'excluded';
}

/**
 * @param strength  map currency -> { classification, score, ... } (from strength.js)
 * @returns { all: [{pair,base,quote,direction|null,baseClass,quoteClass,baseScore,quoteScore,reason}],
 *            qualified: [ ...where direction != null ] }
 */
function qualifyPairs(strength) {
  const all = [];
  for (const pair of PAIRS) {
    const i = pair.indexOf('_');
    const base = pair.slice(0, i), quote = pair.slice(i + 1);
    const sb = strength[base] || {}, sq = strength[quote] || {};
    const cb = sb.classification, cq = sq.classification;
    let direction = null;
    if (cb === 'strong' && cq === 'weak') direction = 'BUY';
    else if (cb === 'weak' && cq === 'strong') direction = 'SELL';
    all.push({
      pair, base, quote, direction,
      baseClass: cb || 'insufficient', quoteClass: cq || 'insufficient',
      baseScore: sb.score == null ? null : sb.score,
      quoteScore: sq.score == null ? null : sq.score,
      reason: direction ? 'qualified' : reasonFor(cb, cq),
    });
  }
  return { all, qualified: all.filter((p) => p.direction) };
}

module.exports = { qualifyPairs };
