'use strict';

/**
 * One-time backfill of structure_snapshots from H1 candles.
 *
 *   node scripts/backfill-structure.js [SINCE_ISO]
 *
 * Default SINCE = 2025-06-01. For each tradeable H1 hour from SINCE to now,
 * recomputes the per-pair structure (trend, BOS, levels, score, state…) using
 * the live engine's analysePair over the trailing 500 H1 candles, aggregates
 * currencies per hour, and upserts. M15 fields are left null (the alignment
 * filter only needs `trend`; M15 is computed live going forward).
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const eng = require('../api/structure-engine');

const { INSTRUMENTS, CURRENCIES, analysePair, aggregateCurrencies, tradeApproval } = eng;
const LOOKBACK = 500;       // H1 candles fed to analysePair
const SINCE = process.argv[2] || '2025-06-01T00:00:00Z';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function fetchAllH1(inst) {
  const rows = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', inst).eq('timeframe', 'H1').eq('complete', true)
      .order('time', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows.map(c => ({ time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
}

async function main() {
  const sinceMs = new Date(SINCE).getTime();
  console.log(`[BACKFILL] structure_snapshots since ${SINCE}`);

  // results[inst] = Map(time_iso -> analysePair result)
  const results = {};
  const allHours = new Set();

  for (const inst of INSTRUMENTS) {
    const candles = await fetchAllH1(inst);
    const m = new Map();
    for (let i = 59; i < candles.length; i++) {
      const t = candles[i].time;
      if (new Date(t).getTime() < sinceMs) continue;
      const window = candles.slice(Math.max(0, i - (LOOKBACK - 1)), i + 1);
      const r = analysePair(window, []); // no M15 in backfill
      if (!r) continue;
      m.set(t, r);
      allHours.add(t);
    }
    results[inst] = m;
    console.log(`[BACKFILL]   ${inst}: ${m.size} hours`);
  }

  const hours = [...allHours].sort();
  console.log(`[BACKFILL] ${hours.length} distinct hours, building rows…`);

  let rows = [];
  let stored = 0;
  const flush = async () => {
    if (!rows.length) return;
    const { error } = await sb.from('structure_snapshots').upsert(rows, { onConflict: 'time_utc,instrument' });
    if (error) throw error;
    stored += rows.length;
    rows = [];
    process.stdout.write(`\r[BACKFILL] upserted ${stored} rows…`);
  };

  for (const hour of hours) {
    // gather this hour's per-pair results for currency aggregation
    const pairResults = {};
    for (const inst of INSTRUMENTS) {
      const r = results[inst].get(hour);
      if (r) pairResults[inst] = r;
    }
    const currencies = aggregateCurrencies(pairResults);

    for (const [inst, r] of Object.entries(pairResults)) {
      const [base, quote] = inst.split('_');
      const approval = tradeApproval(r, currencies, inst); // M15 null -> not approved
      rows.push({
        time_utc: hour,
        instrument: inst,
        structure_score: r.structureScore,
        structure_label: r.structureLabel,
        trend: r.trend,
        market_state: r.state,
        trend_valid: r.trendValid,
        bos_direction: r.bos ? r.bos.direction : null,
        bos_level: r.bos ? r.bos.level : null,
        choch: r.choch || null,
        nearest_support: r.nearestSupport ? r.nearestSupport.price : null,
        nearest_resistance: r.nearestResistance ? r.nearestResistance.price : null,
        invalidation: r.invalidation,
        efficiency: r.efficiency,
        persistence: r.persistence,
        expansion: r.expansion,
        pullback_quality: r.pullbackQuality,
        m15_score: null,
        m15_state: null,
        base_ccy_score: currencies[base]?.avgStructure ?? null,
        quote_ccy_score: currencies[quote]?.avgStructure ?? null,
        trade_approved: approval.approved,
      });
      if (rows.length >= 500) await flush();
    }
  }
  await flush();
  process.stdout.write('\n');
  console.log(`[BACKFILL] Done. Stored ${stored} snapshot rows.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('[BACKFILL] ERROR:', e.message); process.exit(1); });
