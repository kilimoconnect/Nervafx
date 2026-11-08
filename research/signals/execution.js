'use strict';

/**
 * Execution model (spec §7, §10) — ESTIMATED execution on MID-price history.
 *
 * We have no stored bid/ask, so all geometry (reference entry, stop, target, R, intrabar
 * monitoring) is done in MID prices and the cost model is applied as EXPLICIT deductions:
 *   - spread  : one full round-trip spread (pair-specific pips) — counted once, never
 *               double-counted against a bid/ask we do not have;
 *   - slippage: applied adversely on BOTH fills;
 *   - financing (swap): pips per calendar day held (matters for week/month trades);
 *   - commission: $/lot/side — deferred to portfolio sizing (needs a position size).
 * Results are labelled "Estimated execution".
 *
 * Entry (historical candle-only): the modelled fill is the NEXT entry candle's opening
 * mid, under the constraints below; take-profit and stop fills are modelled at their
 * levels except on a gap, where the stop fills at the first executable (gapped) price.
 */

const { pipSize, COST_MODEL, DAY } = require('./config');

/** Per-unit price costs for a round-trip in `pair`, held `daysHeld` days. */
function priceCosts(pair, daysHeld, direction, costs = COST_MODEL) {
  const ps = pipSize(pair);
  const spreadPips = (costs.spreadPips && costs.spreadPips[pair] != null) ? costs.spreadPips[pair] : costs.defaultSpreadPips;
  const spread = spreadPips * ps;                       // one full round-trip spread
  const slippage = 2 * (costs.slippagePips || 0) * ps;  // adverse on both fills
  const swapPerDay = (direction === 'BUY' ? costs.swapPipsPerDayLong : costs.swapPipsPerDayShort) * ps;
  const swap = Math.abs(Math.min(0, swapPerDay)) * Math.max(0, daysHeld); // modelled as a cost (>=0)
  return { spread, slippage, swap, total: spread + slippage + swap, spreadPips, pipSize: ps };
}

/**
 * Decide the entry for a published signal given the next entry candle's opening mid.
 *   signal: { direction, referenceEntry, fixedStop, maxDeviation }
 *   nextOpenMid / nextOpenMs: the next entry candle (undefined => no executable quote).
 *   params: strategy params (spreadStopFrac). costs: cost model (for the spread-vs-stop test).
 * Returns { status: 'OPEN'|'CANCELLED'|'EXPIRED', reason?, fillMid?, fillMs?, initialStop?,
 *           target?, initialRisk? } — all in MID price units.
 */
function decideEntry(signal, nextOpenMid, nextOpenMs, def) {
  const { direction, referenceEntry, fixedStop, maxDeviation } = signal;
  const dir = direction === 'BUY' ? 1 : -1;
  if (nextOpenMid == null || !isFinite(nextOpenMid)) return { status: 'EXPIRED', reason: 'no executable quote before expiry' };

  const fillMid = nextOpenMid;
  const deviation = Math.abs(fillMid - referenceEntry);
  if (deviation > maxDeviation) return { status: 'CANCELLED', reason: 'entry deviation ' + deviation.toFixed(6) + ' > ' + maxDeviation.toFixed(6) };

  // Stop breached or on the wrong side of the actual fill.
  if (direction === 'BUY' && fillMid <= fixedStop) return { status: 'CANCELLED', reason: 'fill at/through stop (wrong side)' };
  if (direction === 'SELL' && fillMid >= fixedStop) return { status: 'CANCELLED', reason: 'fill at/through stop (wrong side)' };

  const initialRisk = Math.abs(fillMid - fixedStop);
  if (!(initialRisk > 0)) return { status: 'CANCELLED', reason: 'zero stop distance at fill' };

  const spreadPrice = priceCosts(signal.pair || '', 0, direction, def.costs).spread;
  if (spreadPrice > def.params.spreadStopFrac * initialRisk) {
    return { status: 'CANCELLED', reason: 'spread ' + spreadPrice.toFixed(6) + ' exceeds ' + (def.params.spreadStopFrac * 100) + '% of entry-to-stop' };
  }

  const target = direction === 'BUY' ? fillMid + def.params.targetR * initialRisk : fillMid - def.params.targetR * initialRisk;
  return { status: 'OPEN', direction, fillMid, fillMs: nextOpenMs, initialStop: fixedStop, target, initialRisk };
}

module.exports = { priceCosts, decideEntry, DAY };
