'use strict';

/**
 * Currency strength from pair directions (spec §5), calculated separately per strategy.
 *
 * Each pair contributes OPPOSITE votes to its two currencies:
 *   bullish pair → base +1, quote −1 ;  bearish pair → base −1, quote +1.
 * For a currency c and one of its 7 legs, the contribution = leg.sign · pairDirection
 * (leg.sign = +1 when c is the base of the provider pair, −1 when c is the quote).
 *
 *   score = (# bullish contributions) − (# bearish contributions)   ∈ [−7, +7]
 *
 * All seven contributions must be VALID (±1) before a currency qualifies; an unknown
 * pair state is NOT counted as a neutral vote — it makes the currency "insufficient".
 * With complete data the eight scores sum to zero (zero-sum construction).
 *
 * Classification uses one symmetric integer threshold in [4,7]:
 *   strong  : bull ≥ threshold
 *   weak    : bear ≥ threshold
 *   neutral : neither (complete data, but no clear side)
 *   insufficient : one or more legs unknown
 */

const { CURRENCIES, legsFor, validThreshold } = require('./config');

function isDir(d) { return d === 1 || d === -1; }

/**
 * @param pairDir  map { 'EUR_USD': +1|-1|0 } (missing / 0 / null = unknown)
 * @param threshold integer 4..7 (validated)
 * @returns map currency -> { currency, score, bull, bear, classification, complete, contributions:[7] }
 */
function currencyStrength(pairDir, threshold) {
  const thr = validThreshold(threshold);
  const pd = pairDir || {};
  const out = {};
  for (const c of CURRENCIES) {
    const legs = legsFor(c);
    let bull = 0, bear = 0, complete = true;
    const contributions = [];
    for (const leg of legs) {
      const dir = pd[leg.pair];
      if (!isDir(dir)) {
        complete = false;
        contributions.push({ counterpart: leg.counterpart, pair: leg.pair, sign: leg.sign, pairDirection: isDir(dir) ? dir : 0, contribution: null });
        continue;
      }
      const contrib = leg.sign * dir;                 // +1 bullish vote | −1 bearish vote for c
      if (contrib > 0) bull += 1; else bear += 1;
      contributions.push({ counterpart: leg.counterpart, pair: leg.pair, sign: leg.sign, pairDirection: dir, contribution: contrib });
    }
    const score = complete ? bull - bear : null;
    const classification = !complete ? 'insufficient'
      : (bull >= thr ? 'strong' : (bear >= thr ? 'weak' : 'neutral'));
    out[c] = { currency: c, score, bull, bear, classification, complete, contributions };
  }
  return out;
}

/** True when every currency has complete data (all 28 pair directions known). */
function allComplete(strength) {
  return CURRENCIES.every((c) => strength[c] && strength[c].complete);
}

/** Sum of the eight scores (0 when complete — a validation hook). */
function scoreSum(strength) {
  let s = 0;
  for (const c of CURRENCIES) { const v = strength[c]; if (v && v.score != null) s += v.score; }
  return s;
}

/** Currencies ranked strongest → weakest (complete first, then by score desc). */
function ranked(strength) {
  return CURRENCIES.map((c) => strength[c]).sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    return (b.score == null ? -99 : b.score) - (a.score == null ? -99 : a.score);
  });
}

module.exports = { currencyStrength, allComplete, scoreSum, ranked };
