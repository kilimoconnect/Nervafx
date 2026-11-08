'use strict';

/**
 * Signal lifecycle assembly (spec §8) — pure. Turns a published signal + entry decision +
 * monitored outcome into an immutable-record projection plus an append-only event list.
 *
 *   PUBLISHED → (EXPIRED | CANCELLED) when the entry never fills, or
 *   PUBLISHED → OPEN → (CLOSED by STOP/TARGET/HOLD_LIMIT | UNRESOLVED | still OPEN at dataset end).
 *
 * Net P&L is MID-geometry gross minus explicit costs (spread once, slippage both sides,
 * financing per day). Commission is applied later at the portfolio level (needs size).
 * Win/loss/breakeven is decided from net P&L after costs. Nothing is overwritten with
 * later information; losing plans keep their original stop/target/risk.
 */

const { priceCosts, DAY } = require('./execution');

const BE_EPS = 1e-9;

function dedupKey(sig) { return [sig.strategyKey, sig.version, sig.pair, sig.entryCloseMs].join('|'); }

/**
 * entryDecision: from decideEntry(...) — { status:'OPEN'|'CANCELLED'|'EXPIRED', ... }.
 * outcome:       from resolveOutcome(...) when entered — may be undefined for non-fills.
 * opts.openAtEnd: true when the holding window extends past the last available data
 *                 (keep the trade OPEN rather than marking it UNRESOLVED).
 */
function buildTrade(signal, entryDecision, outcome, def, opts = {}) {
  const events = [{ type: 'PUBLISHED', atMs: signal.publishedAtMs, payload: { pair: signal.pair, direction: signal.direction, rank: signal.rank } }];

  if (entryDecision.status === 'EXPIRED' || entryDecision.status === 'CANCELLED') {
    events.push({ type: entryDecision.status, atMs: signal.entryExpiryMs, payload: { reason: entryDecision.reason } });
    return {
      status: entryDecision.status, reason: entryDecision.reason,
      modelledFill: null, fillMs: null, initialStop: signal.fixedStop, target: signal.indicativeTarget,
      initialRisk: null, exitPrice: null, exitMs: null, exitReason: null,
      costs: {}, netPnlAcct: null, netR: null, ambiguityFlag: false,
      dataQuality: { estimatedExecution: true }, result: null, events,
    };
  }

  // Entered.
  const { fillMid, fillMs, initialStop, target, initialRisk } = entryDecision;
  events.push({ type: 'ENTERED', atMs: fillMs, payload: { fill: fillMid, stop: initialStop, target, risk: initialRisk } });

  if (!outcome || outcome.status === 'UNRESOLVED') {
    if (opts.openAtEnd) {
      return {
        status: 'OPEN', modelledFill: fillMid, fillMs, initialStop, target, initialRisk,
        exitPrice: null, exitMs: null, exitReason: null, costs: {}, netPnlAcct: null, netR: null,
        ambiguityFlag: false, dataQuality: { estimatedExecution: true, monitorTf: outcome && outcome.monitorTf, openAtDatasetEnd: true }, result: null, events,
      };
    }
    events.push({ type: 'UNRESOLVED', atMs: fillMs, payload: { reason: (outcome && outcome.reason) || 'missing intrabar data' } });
    return {
      status: 'UNRESOLVED', reason: (outcome && outcome.reason) || 'missing intrabar data',
      modelledFill: fillMid, fillMs, initialStop, target, initialRisk,
      exitPrice: null, exitMs: null, exitReason: 'UNRESOLVED', costs: {}, netPnlAcct: null, netR: null,
      ambiguityFlag: false, dataQuality: { estimatedExecution: true, monitorTf: outcome && outcome.monitorTf }, result: null, events,
    };
  }

  // Closed.
  const dir = signal.direction === 'BUY' ? 1 : -1;
  const exitMid = outcome.exitMid, exitMs = outcome.exitMs;
  const daysHeld = Math.max(0, (exitMs - fillMs) / DAY);
  const costs = priceCosts(signal.pair, daysHeld, signal.direction, def.costs);
  const grossPrice = dir * (exitMid - fillMid);
  const netPrice = grossPrice - costs.total;
  const netR = netPrice / initialRisk;
  const result = Math.abs(netR) < BE_EPS ? 'breakeven' : (netR > 0 ? 'win' : 'loss');

  // Ambiguity sensitivity: the alternative (target-first) net R had we not used stop-first.
  let altNetR = null;
  if (outcome.ambiguity && outcome.alternative) {
    const altGross = dir * (outcome.alternative.exitMid - fillMid);
    altNetR = (altGross - costs.total) / initialRisk;
  }

  const evType = outcome.exitReason === 'HOLD_LIMIT' ? 'HOLD_EXIT' : outcome.exitReason; // STOP|TARGET|HOLD_EXIT
  events.push({ type: evType, atMs: exitMs, payload: { exit: exitMid, grossPrice, netPrice, netR, daysHeld } });

  return {
    status: 'CLOSED', modelledFill: fillMid, fillMs, initialStop, target, initialRisk,
    exitPrice: exitMid, exitMs, exitReason: outcome.exitReason,
    costs: { spread: costs.spread, slippage: costs.slippage, swap: costs.swap, total: costs.total, daysHeld, grossPrice, netPrice },
    netPnlAcct: netPrice, netR, result,
    ambiguityFlag: !!outcome.ambiguity,
    dataQuality: { estimatedExecution: true, monitorTf: outcome.monitorTf, ambiguity: !!outcome.ambiguity, altNetR, gap: !!(outcome.flags && outcome.flags.gap) },
    events,
  };
}

module.exports = { buildTrade, dedupKey, BE_EPS };
