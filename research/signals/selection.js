'use strict';

/**
 * Pair selection — period differential ranking (spec §3).
 *
 * A currency's period log return is ln(index_now / index_baseline), where the index is
 * the zero-sum 1/8 relative index (comparison engine). Because that index accumulates
 * multiplicatively from per-step log returns, ln(idx_end/idx_start) telescopes exactly to
 * the currency's cumulative log return over [baseline, now] — no raw-level subtraction,
 * no mixing of simple and log returns.
 *
 *   differential(A/B) = rA(period) − rB(period)
 *   differential > 0 → BUY A/B ; < 0 → SELL A/B ; == 0 → no directional candidate.
 *
 * All 28 economic pairs are ranked once each by |differential| (desc); ties broken by
 * pair symbol (asc). The top-N (default 3) are selected. The caller stores the full
 * ranking snapshot used for the decision.
 */

const { PAIRS } = require('./config');
const { idxAtOrBefore } = require('../comparison/index-build');

/** Currency period log return from baselineMs to asOfMs (uses carry at each boundary). */
function currencyPeriodReturn(built, ccy, baselineMs, asOfMs) {
  const a = idxAtOrBefore(built, ccy, baselineMs);
  const b = idxAtOrBefore(built, ccy, asOfMs);
  if (!a || !b || !(a.value > 0) || !(b.value > 0)) return null;
  return Math.log(b.value / a.value);
}

/** Period log returns for every currency; null where unavailable. */
function currencyReturns(built, currencies, baselineMs, asOfMs) {
  const out = {};
  for (const c of currencies) out[c] = currencyPeriodReturn(built, c, baselineMs, asOfMs);
  return out;
}

/**
 * Rank all 28 pairs by |differential| (desc), tie by pair symbol (asc).
 * Returns [{pair, a, b, rA, rB, differential, bias, absDiff, rank}], rank starting at 1.
 * Pairs with any missing currency return or an exactly-zero differential get bias 'none'
 * and are ranked last (they cannot be directional candidates).
 */
function rankPairs(returns, pairs = PAIRS) {
  const rows = pairs.map((pair) => {
    const [a, b] = pair.split('_');
    const rA = returns[a], rB = returns[b];
    if (rA == null || rB == null) {
      return { pair, a, b, rA, rB, differential: null, bias: 'none', absDiff: -1, reason: 'missing currency return' };
    }
    const diff = rA - rB;
    const bias = diff > 0 ? 'BUY' : (diff < 0 ? 'SELL' : 'none');
    return { pair, a, b, rA, rB, differential: diff, bias, absDiff: Math.abs(diff) };
  });
  rows.sort((x, y) => {
    if (y.absDiff !== x.absDiff) return y.absDiff - x.absDiff;   // larger |diff| first
    return x.pair < y.pair ? -1 : (x.pair > y.pair ? 1 : 0);     // deterministic tie-break
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/**
 * The shortlist = the top-N pairs strictly by rank (largest |differential| first).
 * We take ranks 1..N as-is and NEVER substitute a lower-ranked pair — a shortlisted
 * pair with a zero/'none' differential is simply a non-actionable member (it cannot
 * produce a directional candidate), not replaced by rank N+1.
 */
function topN(ranked, n) {
  return ranked.slice(0, n);
}

module.exports = { currencyPeriodReturn, currencyReturns, rankPairs, topN };
