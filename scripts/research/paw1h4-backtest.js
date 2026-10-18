'use strict';

/**
 * PA_W1_H4_CONTINUATION backtest runner (read-only; no deploy/migrate/push).
 *
 *   node scripts/research/paw1h4-backtest.js
 *
 * Loads stored H1 from Supabase, aggregates W1+H4, runs the strategy and the two
 * required comparisons, computes metrics (full history + a chronological OOS slice +
 * a doubled-cost sensitivity run), and writes docs/research/paw1h4_backtest.json.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { CONFIG, PAIRS } = require('../../research/paw1h4/config');
const { loadH1Parallel } = require('../../research/paw1h4/dbload');
const { aggregates, runStrategy, runWeeklyBaseline } = require('../../research/paw1h4/pipeline');
const { computeMetrics } = require('../../research/paw1h4/metrics');

function dataAudit(h1byPair) {
  const audit = {};
  for (const p of Object.keys(h1byPair)) {
    const h1 = h1byPair[p];
    const { h4, w1 } = aggregates(h1);
    audit[p] = {
      h1: h1.length, h4: h4.length, w1: w1.length,
      h4partial: h4.filter((c) => c.partial).length,
      firstH1: h1.length ? new Date(h1[0].openMs).toISOString() : null,
      lastH1: h1.length ? new Date(h1[h1.length - 1].openMs).toISOString() : null,
    };
  }
  return audit;
}

/** Split trades into exploratory (first `frac`) and OOS (remainder) by signal date. */
function oosSlice(trades, frac) {
  const withT = trades.filter((t) => t.signalCloseMs != null).sort((a, b) => a.signalCloseMs - b.signalCloseMs);
  if (!withT.length) return { split: null, oos: [] };
  const span = withT[withT.length - 1].signalCloseMs - withT[0].signalCloseMs;
  const splitMs = withT[0].signalCloseMs + span * frac;
  return { split: new Date(splitMs).toISOString(), oos: trades.filter((t) => t.signalCloseMs > splitMs) };
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE creds in env'); process.exit(2); }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const pairs = process.argv[2] ? process.argv[2].split(',') : PAIRS;
  console.error(`Loading H1 for ${pairs.length} pairs…`);
  const h1byPair = await loadH1Parallel(sb, pairs, {}, 8);

  const audit = dataAudit(h1byPair);
  const strat = [], h4self = [], baseline = [], stratHighCost = [];
  const highCostCfg = Object.assign({}, CONFIG, { execution: Object.assign({}, CONFIG.execution, { spreadPips: CONFIG.execution.spreadPips * 2, slippagePips: CONFIG.execution.slippagePips * 2 }) });

  for (const p of pairs) {
    const h1 = h1byPair[p]; if (!h1 || h1.length < 300) continue;
    strat.push(...runStrategy(h1, p, CONFIG, 'weekly').trades);
    h4self.push(...runStrategy(h1, p, CONFIG, 'h4self').trades);
    baseline.push(...runWeeklyBaseline(h1, p, CONFIG).trades);
    stratHighCost.push(...runStrategy(h1, p, highCostCfg, 'weekly').trades);
  }

  const oos = oosSlice(strat, 0.6);
  const report = {
    strategyId: CONFIG.strategyId, version: CONFIG.version, generatedAt: new Date().toISOString(),
    economics: 'MID-ONLY ESTIMATED — spreads/slippage/commission modelled from config, not broker fills',
    sampleNote: 'Rules frozen a priori (price-action only, not tuned on returns). History is short for a weekly-trend strategy; treat as EXPLORATORY. OOS slice = last 40% of signals by date.',
    config: CONFIG,
    dataAudit: audit,
    results: {
      strategy_weekly: computeMetrics(strat),
      comparison_h4_only_no_weekly_filter: computeMetrics(h4self),
      comparison_weekly_structure_baseline: computeMetrics(baseline),
      strategy_weekly_OOS_last40pct: Object.assign({ oosSplitAt: oos.split }, computeMetrics(oos.oos)),
      cost_sensitivity_doubled_costs: computeMetrics(stratHighCost),
    },
  };

  const outPath = path.join(__dirname, '..', '..', 'docs', 'research', 'paw1h4_backtest.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  const m = report.results;
  const line = (k, r) => `  ${k.padEnd(42)} n=${String(r.accepted).padStart(3)}  exp=${String(r.expectancyR).padStart(7)}R  PF=${String(r.profitFactor).padStart(6)}  win=${(r.winRate * 100).toFixed(0)}%  maxDD=${r.maxDrawdownR}R  streak=${r.maxLosingStreak}`;
  console.error('\n=== PA_W1_H4_CONTINUATION backtest ===');
  console.error(line('strategy (weekly-filtered)', m.strategy_weekly));
  console.error(line('comparison: H4-only (no weekly filter)', m.comparison_h4_only_no_weekly_filter));
  console.error(line('comparison: weekly-structure baseline', m.comparison_weekly_structure_baseline));
  console.error(line('strategy OOS (last 40%)', m.strategy_weekly_OOS_last40pct));
  console.error(line('strategy @ doubled costs', m.cost_sensitivity_doubled_costs));
  console.error('rejections (weekly):', JSON.stringify(m.strategy_weekly.rejectByReason));
  console.error('max concurrent exposure (weekly):', m.strategy_weekly.maxConcurrentExposure);
  console.error(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
