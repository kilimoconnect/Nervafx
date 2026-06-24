'use strict';

/**
 * One-time backfill of structure_snapshots from H1 candles.
 *
 *   node scripts/backfill-structure.js [SINCE_ISO]
 *
 * Default SINCE = 2025-06-01. For each tradeable H1 hour from SINCE to now,
 * recomputes the per-pair structure (trend, BOS, levels, score, state…) using
 * the live engine's analysePair over the trailing 500 H1 candles, aggregates
 * currencies per hour, and upserts. M15 score/state are computed from the M15
 * candles available at each hour (so historical trade-approval works too).
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

async function fetchAllCandles(inst, timeframe) {
  const rows = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, open, high, low, close')
      .eq('instrument', inst).eq('timeframe', timeframe).eq('complete', true)
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
    const m15 = await fetchAllCandles(inst, 'M15');
    const m = new Map();
    let m15Ptr = 0; // count of M15 candles with time <= current hour
    for (let i = 59; i < candles.length; i++) {
      const t = candles[i].time;
      const tMs = new Date(t).getTime();
      // advance M15 pointer to include all candles at or before this H1 hour
      while (m15Ptr < m15.length && new Date(m15[m15Ptr].time).getTime() <= tMs) m15Ptr++;
      if (tMs < sinceMs) continue;
      const window = candles.slice(Math.max(0, i - (LOOKBACK - 1)), i + 1);
      const m15Window = m15.slice(Math.max(0, m15Ptr - 10), m15Ptr);
      const r = analysePair(window, m15Window); // M15 quality computed at this hour
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
      const approval = tradeApproval(r, currencies, inst); // now uses computed M15
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
        m15_score: r.m15 ? r.m15.score : null,
        m15_state: r.m15 ? r.m15.state : null,
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
