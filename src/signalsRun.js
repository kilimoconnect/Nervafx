'use strict';

/**
 * CLI for the trade-signal engine (research; MODELLED, estimated execution).
 *
 *   node src/signalsRun.js backfill [--from=ISO] [--to=ISO] [--strategy=today,week,month]
 *
 * Dry-run by default: reconstructs historical signals + outcomes over the window and prints
 * REAL per-strategy counts. No DB writes, no fabricated results. (DB persistence lands with
 * the cron/endpoint once sql/030_trade_signals.sql has been applied.)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { backfill, summarize } = require('./signalEngine');
const { STRATEGY_KEYS } = require('../research/signals/config');

function arg(name, def) { const m = process.argv.find((a) => a.startsWith('--' + name + '=')); return m ? m.split('=').slice(1).join('=') : def; }

async function main() {
  const cmd = process.argv[2] || 'backfill';
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  if (cmd !== 'backfill') { console.error('unknown command: ' + cmd); process.exit(1); }

  const fromIso = arg('from');
  const toIso = arg('to');
  const strategies = (arg('strategy') ? arg('strategy').split(',') : STRATEGY_KEYS).filter((k) => STRATEGY_KEYS.includes(k));

  console.log('NervaFX trade-signal backfill (DRY-RUN — MODELLED, estimated execution; NOT real results)');
  console.log('window:', fromIso || '(all)', '→', toIso || '(all)', '| strategies:', strategies.join(', '));
  const t0 = Date.now();
  const res = await backfill(sb, { strategies, fromIso, toIso });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  for (const key of strategies) {
    const r = res[key];
    if (!r || !r.ok) { console.log(`\n[${key}] NOT RUN — ${r && r.reason}`); continue; }
    const s = summarize(r.trades);
    console.log(`\n=== ${key.toUpperCase()} ===  (grid ${r.grid} evaluations)`);
    console.log(`  published ${s.published} | entered ${s.entered} | closed ${s.closed} | open ${s.open} | expired ${s.expired} | cancelled ${s.cancelled} | unresolved ${s.unresolved}`);
    console.log(`  wins ${s.wins} | losses ${s.losses} | breakeven ${s.breakeven} | win rate ${s.winRate == null ? '—' : s.winRate + '%'} (resolved closed)`);
    console.log(`  avg net R ${s.avgNetR == null ? '—' : s.avgNetR} | total net R ${s.totalNetR} | profit factor ${s.profitFactor == null ? '—' : s.profitFactor}`);
    console.log(`  monitored by M5 ${s.grossMonitorM5} / M15 ${s.grossMonitorM15} | ambiguous (stop+target same bar) ${s.ambiguous}`);
  }
  console.log(`\ndone in ${dt}s. (Win rate denominator = resolved closed trades; pending/open/expired/cancelled excluded.)`);
}

main().catch((e) => { console.error('ERROR', e && e.stack || e); process.exit(1); });
