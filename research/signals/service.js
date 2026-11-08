'use strict';

/**
 * Snapshot service — assembles everything the UI needs for all three strategies from a
 * single live computation over a window: current shortlist (top-3 + all 28), current/open
 * signals, historical signals, per-strategy statistics + period reports, and the independent
 * and combined model portfolios. All MODELLED / estimated execution; NOT real results.
 *
 * (This computes live from candles so the UI works before the persisted tables + cron exist.
 * Once sql/030 is applied and the cron runs, forward signals are persisted and read directly.)
 */

const { backfill } = require('../../src/signalEngine');
const { evaluateAt } = require('./evaluate');
const { strategyStats, byPeriod, byPair, byDirection, byRank, byOrigin } = require('./stats');
const { simulate } = require('./portfolio');
const { DEFAULT_PARAMS, STRATEGY_KEYS, TF_MS } = require('./config');

const PORT_PARAMS = {
  initialEquity: DEFAULT_PARAMS.initialEquity,
  riskPerTradePct: DEFAULT_PARAMS.riskPerTradePct,
  maxAggregateRiskPct: DEFAULT_PARAMS.maxAggregateRiskPct,
  maxPerCurrencyRiskPct: DEFAULT_PARAMS.maxPerCurrencyRiskPct,
};

function tradeView(t) {
  const s = t.signal;
  return {
    key: [s.strategyKey, s.version, s.pair, s.entryCloseMs].join('|'),
    strategy: s.strategyKey, version: s.version, origin: s.origin || 'historical',
    pair: s.pair, direction: s.direction, rank: s.rank, differential: round(s.periodDifferential),
    publishedAtMs: s.publishedAtMs, entryCloseMs: s.entryCloseMs, entryExpiryMs: s.entryExpiryMs,
    referenceEntry: round(s.referenceEntry), maxDeviation: round(s.maxDeviation),
    fixedStop: round(s.fixedStop), indicativeTarget: round(s.indicativeTarget), atr: round(s.atr),
    status: t.status, modelledFill: round(t.modelledFill), fillMs: t.fillMs,
    initialStop: round(t.initialStop), target: round(t.target), initialRisk: round(t.initialRisk),
    exitPrice: round(t.exitPrice), exitMs: t.exitMs, exitReason: t.exitReason,
    netR: t.netR == null ? null : +t.netR.toFixed(4), result: t.result,
    monitorTf: t.dataQuality && t.dataQuality.monitorTf, ambiguity: !!t.ambiguityFlag,
    reason: t.reason || null,
  };
}
function tradeDetail(t) {
  const s = t.signal;
  return Object.assign(tradeView(t), {
    confirmation: s.confirmation, trigger: s.trigger, costs: t.costs,
    events: t.events, dataQuality: t.dataQuality,
  });
}
function round(x) { return x == null ? null : +(+x).toFixed(6); }

/** Shortlist rows (top-3) + the full 28 ranking, from a fresh evaluation at the latest asOf. */
function latestBoard(def, ctx, lastAsOf) {
  const ev = evaluateAt(def, lastAsOf, ctx);
  if (!ev.ok) return { ok: false, reason: ev.reason, asOf: lastAsOf };
  const shortlist = ev.shortlist.map((r) => ({
    rank: r.rank, pair: r.pair, bias: r.bias, differential: round(r.differential), status: r.status,
    confirmPass: r.confirmation ? r.confirmation.pass : null,
    breadth: r.confirmation ? {
      A: r.confirmation.breadth.A ? { up: r.confirmation.breadth.A.up, down: r.confirmation.breadth.A.down } : null,
      B: r.confirmation.breadth.B ? { up: r.confirmation.breadth.B.up, down: r.confirmation.breadth.B.down } : null,
    } : null,
    triggerPass: r.trigger ? r.trigger.pass : null,
    reasons: r.reasons || [],
  }));
  const ranking = ev.ranking.map((r) => ({ rank: r.rank, pair: r.pair, bias: r.bias, differential: round(r.differential) }));
  return { ok: true, asOf: lastAsOf, baselineMs: ev.baselineMs, confirmInterval: ev.confirmInterval, shortlist, ranking, justPublished: ev.signals.map((sg) => sg.pair) };
}

async function computeSnapshot(sb, { strategies = STRATEGY_KEYS, fromIso, toIso } = {}) {
  const res = await backfill(sb, { strategies, fromIso, toIso });
  const out = { generatedAt: Date.now(), window: { fromIso: fromIso || null, toIso: toIso || null }, params: PORT_PARAMS, strategies: {}, disclaimer: 'MODELLED research signals — estimated execution (mid-price history, no bid/ask). UNVALIDATED. Not real trading results; no broker orders.' };
  const allTrades = [];

  for (const key of strategies) {
    const r = res[key];
    if (!r || !r.ok) { out.strategies[key] = { ok: false, reason: r && r.reason }; continue; }
    const def = r.def, trades = r.trades;
    for (const t of trades) allTrades.push(t);
    const board = latestBoard(def, r.ctx, r.lastAsOf);
    const stats = strategyStats(trades, def.entryMs);
    const openTrades = trades.filter((t) => t.status === 'OPEN');
    out.strategies[key] = {
      ok: true, label: def.label, version: def.version,
      confirmTf: def.confirmTf, entryTf: def.entryTf, lastAsOf: r.lastAsOf, lastDataMs: r.lastDataMs,
      board, stats,
      current: { open: openTrades.map(tradeView), justPublished: board.ok ? board.justPublished : [] },
      history: trades.map(tradeView),
      byPair: byPair(trades), byDirection: byDirection(trades), byRank: byRank(trades), byOrigin: byOrigin(trades),
      reports: { daily: byPeriod(trades, 'daily'), weekly: byPeriod(trades, 'weekly'), monthly: byPeriod(trades, 'monthly') },
      portfolio: simulate(trades, PORT_PARAMS),
      rawTrades: trades,   // full lifecycle trades for the detail view (server-side only)
    };
  }

  out.combined = simulate(allTrades, PORT_PARAMS, { combined: true });
  out.combinedNote = 'Combined applies shared risk limits + conflict rules across strategies; it is NOT the sum of the independent returns.';
  return out;
}

/** Full detail for one trade identified by its dedup key, from a computed snapshot's strategy. */
function findDetail(snapshotStrategyTrades, key) {
  const t = snapshotStrategyTrades.find((x) => [x.signal.strategyKey, x.signal.version, x.signal.pair, x.signal.entryCloseMs].join('|') === key);
  return t ? tradeDetail(t) : null;
}

module.exports = { computeSnapshot, latestBoard, tradeView, tradeDetail, findDetail, PORT_PARAMS };
