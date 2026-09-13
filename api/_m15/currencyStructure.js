'use strict';

/**
 * M15 Intelligence — currency-structure engine (§15).
 *
 * Aggregates the M15 structural behaviour of every pair containing a currency
 * into one broad state, exposing supporting/conflicting pairs, breadth, the
 * direction of structural change, and whether participation is broad or
 * concentrated (moving against the whole board vs only one weak counterpart).
 *
 * States: BROAD_BULLISH_TRANSITION / _EXPANSION / _CONTROL, the bearish mirrors,
 * MIXED, NEUTRAL, EXHAUSTED. Pure & deterministic.
 *
 * Input: perPair[pair] = { direction:'BULLISH'|'BEARISH'|'NEUTRAL',
 *                          expansionState, freshness, movementStage }.
 */

const { CONFIG } = require('./config');
const { CURRENCIES, pairsForCurrency } = require('./pairs');

function evaluateCurrencyStructure(perPair, opts = {}) {
  const byCurrency = {};
  for (const ccy of CURRENCIES) {
    const members = pairsForCurrency(ccy);
    let bull = 0, bear = 0, neutral = 0;
    const stances = [];
    for (const { pair, role } of members) {
      const rec = perPair[pair] || {};
      const roleSign = role === 'BASE' ? 1 : -1;
      const pairDir = rec.direction === 'BULLISH' ? 1 : rec.direction === 'BEARISH' ? -1 : 0;
      const ccyDir = roleSign * pairDir;           // + ⇒ this currency advancing in that pair
      if (ccyDir > 0) bull++; else if (ccyDir < 0) bear++; else neutral++;
      stances.push({ pair, ccyDir, expansionState: rec.expansionState, freshness: rec.freshness, movementStage: rec.movementStage });
    }
    const n = members.length;
    const netSign = bull > bear ? 1 : bear > bull ? -1 : 0;
    const majority = Math.max(bull, bear);
    const breadth = majority / n;
    const supporting = stances.filter((s) => netSign !== 0 && s.ccyDir === netSign).map((s) => s.pair);
    const conflicting = stances.filter((s) => netSign !== 0 && s.ccyDir === -netSign).map((s) => s.pair);
    const supportStances = stances.filter((s) => netSign !== 0 && s.ccyDir === netSign);

    const stage = classifyStage(supportStances);
    const state = classifyState(netSign, breadth, neutral, n, stage);

    byCurrency[ccy] = {
      currency: ccy, state,
      direction: netSign > 0 ? 'BULLISH' : netSign < 0 ? 'BEARISH' : 'NEUTRAL',
      breadth: +breadth.toFixed(3),
      participation: breadth >= 0.6 ? 'BROAD' : 'CONCENTRATED',
      supportingPairs: supporting, conflictingPairs: conflicting,
      counts: { bullish: bull, bearish: bear, neutral },
    };
  }
  return { byCurrency };
}

/** Stage from the supporting pairs' expansion / freshness / movement maturity. */
function classifyStage(supportStances) {
  if (!supportStances.length) return 'NEUTRAL';
  const tally = (fn) => supportStances.filter(fn).length / supportStances.length;
  const exhausted = tally((s) => s.freshness === 'LATE' || s.freshness === 'EXHAUSTED' || s.movementStage === 'EXHAUSTING');
  const transition = tally((s) => s.expansionState === 'EARLY' || s.expansionState === 'ATTEMPTING');
  const expansion = tally((s) => s.expansionState === 'CONFIRMED' || s.expansionState === 'DEVELOPED');
  const control = tally((s) => s.movementStage === 'MATURE' || s.movementStage === 'DEVELOPED');
  if (exhausted >= 0.5) return 'EXHAUSTED';
  if (transition >= 0.4) return 'TRANSITION';
  if (expansion >= 0.4) return 'EXPANSION';
  if (control >= 0.4) return 'CONTROL';
  return 'TRANSITION';
}

function classifyState(netSign, breadth, neutral, n, stage) {
  if (stage === 'EXHAUSTED' && netSign !== 0) return 'EXHAUSTED';
  if (netSign === 0 || breadth < 0.45) return neutral >= Math.ceil(n / 2) ? 'NEUTRAL' : 'MIXED';
  const dir = netSign > 0 ? 'BULLISH' : 'BEARISH';
  const st = stage === 'CONTROL' ? 'CONTROL' : stage === 'EXPANSION' ? 'EXPANSION' : 'TRANSITION';
  return `BROAD_${dir}_${st}`;
}

module.exports = { evaluateCurrencyStructure };
