'use strict';

/**
 * PA_D1_H1_CONTINUATION backtest runner (read-only; no deploy/migrate/push).
 *
 *   node scripts/research/pad1h1-backtest.js [PAIR,PAIR,...]
 *
 * Loads stored H1, runs the Daily→H1 strategy and its two required comparisons,
 * ALSO runs Weekly→H4 over the SAME pairs/period/costs, and reports a combined
 * portfolio view that flags overlapping same-pair opportunities and shared-currency
 * concurrent exposure (the two models are NOT independent confirmation). Writes
 * docs/research/pad1h1_backtest.json.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { loadH1 } = require('../../research/paw1h4/dbload');
const agg = require('../../research/paw1h4/aggregate');
const { computeMetrics } = require('../../research/paw1h4/metrics');
const d1h1 = require('../../research/pad1h1');
const { runStrategy, runTrendBaseline } = require('../../research/paw1h4/pipeline');
const { CONFIG: W1H4_CONFIG } = require('../../research/paw1h4/config');
const { PAIRS, CONFIG } = require('../../research/pad1h1');

function audit(h1byPair) {
  const a = {};
  for (const p of Object.keys(h1byPair)) {
    const h1 = h1byPair[p]; const d = agg.d1(h1, Infinity);
    a[p] = { h1: h1.length, d1: d.length, d1partial: d.filter((c) => c.partial).length, firstH1: h1.length ? new Date(h1[0].openMs).toISOString() : null, lastH1: h1.length ? new Date(h1[h1.length - 1].openMs).toISOString() : null };
  }
  return a;
}
function oosSlice(trades, frac) {
  const w = trades.filter((t) => t.signalCloseMs != null).sort((a, b) => a.signalCloseMs - b.signalCloseMs);
  if (!w.length) return { split: null, oos: [] };
  const splitMs = w[0].signalCloseMs + (w[w.length - 1].signalCloseMs - w[0].signalCloseMs) * frac;
  return { split: new Date(splitMs).toISOString(), oos: trades.filter((t) => t.signalCloseMs > splitMs) };
}
const ccys = (pair) => pair.split('_');
function combinedExposure(trades) {
  const acc = trades.filter((t) => t.accepted && t.exit && t.entryOpenMs != null);
  // overlapping SAME-PAIR opportunities (across strategies)
  let samePairOverlaps = 0;
  for (let i = 0; i < acc.length; i++) for (let k = i + 1; k < acc.length; k++) {
    if (acc[i].pair === acc[k].pair && acc[i].entryOpenMs < acc[k].exit.ms && acc[k].entryOpenMs < acc[i].exit.ms) samePairOverlaps++;
  }
  // max concurrent trades sharing a currency
  const byCcy = {};
  for (const c of ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']) {
    const ev = [];
    for (const t of acc) if (ccys(t.pair).includes(c)) { ev.push([t.entryOpenMs, 1]); ev.push([t.exit.ms, -1]); }
    ev.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    let open = 0, mx = 0; for (const e of ev) { open += e[1]; if (open > mx) mx = open; }
    byCcy[c] = mx;
  }
  return { samePairOverlaps, maxConcurrentByCurrency: byCcy };
}

async function main() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const pairs = process.argv[2] ? process.argv[2].split(',') : PAIRS;
  console.error(`Loading H1 for ${pairs.length} pairs…`);
  const h1byPair = await loadH1(sb, pairs);

  const d1Strat = [], d1Self = [], d1Base = [], w4Strat = [], d1HighCost = [];
  const highCost = Object.assign({}, CONFIG, { execution: Object.assign({}, CONFIG.execution, { spreadPips: CONFIG.execution.spreadPips * 2, slippagePips: CONFIG.execution.slippagePips * 2 }) });
  for (const p of pairs) {
    const h1 = h1byPair[p]; if (!h1 || h1.length < 300) continue;
    d1Strat.push(...d1h1.runStrat(h1, p, CONFIG, 'trend').trades);
    d1Self.push(...d1h1.runStrat(h1, p, CONFIG, 'self').trades);
    d1Base.push(...d1h1.runBaseline(h1, p, CONFIG).trades);
    d1HighCost.push(...d1h1.runStrat(h1, p, highCost, 'trend').trades);
    w4Strat.push(...runStrategy(h1, p, W1H4_CONFIG, 'trend').trades);  // same period/costs
  }
  const oos = oosSlice(d1Strat, 0.6);
  const combined = d1Strat.filter((t) => t.accepted).concat(w4Strat.filter((t) => t.accepted));

  const report = {
    strategyId: CONFIG.strategyId, version: CONFIG.version, generatedAt: new Date().toISOString(),
    economics: 'MID-ONLY ESTIMATED — spread/slippage/commission from config, not broker fills',
    sampleNote: 'Rules frozen a priori (price action only, not tuned on returns). History is short for a daily-trend strategy; EXPLORATORY. OOS slice = last 40% of signals by date.',
    config: CONFIG,
    dataAudit: audit(h1byPair),
    results: {
      strategy_daily: computeMetrics(d1Strat),
      comparison_h1_only_no_daily_filter: computeMetrics(d1Self),
      comparison_daily_structure_baseline: computeMetrics(d1Base),
      strategy_daily_OOS_last40pct: Object.assign({ oosSplitAt: oos.split }, computeMetrics(oos.oos)),
      cost_sensitivity_doubled_costs: computeMetrics(d1HighCost),
    },
    comparison_with_weekly_h4_same_period: computeMetrics(w4Strat),
    combined_portfolio: {
      note: 'The two models share the same price data and overlap in time/currencies — do NOT treat concurrent signals as independent confirmation.',
      metrics_naive_pooled: computeMetrics(combined),
      exposure: combinedExposure(combined),
    },
  };
  const outPath = path.join(__dirname, '..', '..', 'docs', 'research', 'pad1h1_backtest.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  const m = report.results;
  const line = (k, r) => `  ${k.padEnd(44)} n=${String(r.accepted).padStart(3)}  exp=${String(r.expectancyR).padStart(7)}R  PF=${String(r.profitFactor).padStart(6)}  win=${(r.winRate * 100).toFixed(0)}%  maxDD=${r.maxDrawdownR}R  streak=${r.maxLosingStreak}`;
  console.error('\n=== PA_D1_H1_CONTINUATION backtest ===');
  console.error(line('strategy (daily-filtered)', m.strategy_daily));
  console.error(line('comparison: H1-only (no daily filter)', m.comparison_h1_only_no_daily_filter));
  console.error(line('comparison: daily-structure baseline', m.comparison_daily_structure_baseline));
  console.error(line('strategy OOS (last 40%)', m.strategy_daily_OOS_last40pct));
  console.error(line('strategy @ doubled costs', m.cost_sensitivity_doubled_costs));
  console.error(line('Weekly→H4 (same period)', report.comparison_with_weekly_h4_same_period));
  console.error(line('COMBINED naive pooled', report.combined_portfolio.metrics_naive_pooled));
  console.error('rejections (daily):', JSON.stringify(m.strategy_daily.rejectByReason));
  console.error('combined same-pair overlaps:', report.combined_portfolio.exposure.samePairOverlaps, '| shared-ccy max concurrent:', JSON.stringify(report.combined_portfolio.exposure.maxConcurrentByCurrency));
  console.error(`\nWrote ${outPath}`);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
