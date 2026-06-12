'use strict';

/**
 * Backfill m15_currency_strength from stored M15 candles (backtest_candles).
 *
 * Replicates src/m15.js math exactly:
 *   norm[c]   = avg over c's pairs of (close_t − close_{t−45m}) / close_{t−45m}
 *               (base +mv, quote −mv)
 *   smooth    = (norm at t−15m + norm at t) / 2   — same EMA as the live engine
 *
 * Where the live engine requires all 28 instruments, the backfill divides by
 * the actual pair count per currency so early data (fewer instruments) still
 * produces values.
 *
 * Usage: node scripts/backfill-m15-strength.js [--dry]
 */

require('dotenv').config({ quiet: true });
const { supabase } = require('../src/supabase');

const DRY = process.argv.includes('--dry');
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const M15 = 15 * 60 * 1000;

(async () => {
  console.log('Fetching M15 candle closes (paginated)…');
  // closes[instrument] = Map(ms → close)
  const closes = {};
  const allTimes = new Set();
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, instrument, close')
      .eq('timeframe', 'M15')
      .eq('complete', true)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const r of data) {
      const ms = new Date(r.time).getTime();
      (closes[r.instrument] = closes[r.instrument] || new Map()).set(ms, parseFloat(r.close));
      allTimes.add(ms);
    }
    offset += data.length;
    if (offset % 50000 < PAGE) console.log(`  …${offset} rows`);
    if (data.length < PAGE) break;
  }
  console.log(`Loaded ${offset} candle rows, ${allTimes.size} unique timestamps, ${Object.keys(closes).length} instruments`);

  const instruments = Object.keys(closes);
  const times = [...allTimes].sort((a, b) => a - b);

  // What's already archived (skip those timestamps)
  const existing = new Set();
  let exOffset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('m15_currency_strength')
      .select('time')
      .order('time', { ascending: true })
      .range(exOffset, exOffset + PAGE - 1);
    if (error) {
      if (/does not exist|relation/.test(error.message)) {
        console.error('Table m15_currency_strength missing — run supabase/migration_m15_currency_strength.sql first.');
        process.exit(1);
      }
      throw new Error(error.message);
    }
    if (!data?.length) break;
    for (const r of data) existing.add(new Date(r.time).getTime());
    exOffset += data.length;
    if (data.length < PAGE) break;
  }
  console.log(`${existing.size} timestamps already archived — skipping those`);

  function normAt(ms) {
    // Per-currency normalized 45m strength at timestamp ms
    const sums = {}, counts = {};
    for (const inst of instruments) {
      const m = closes[inst];
      const cNow = m.get(ms);
      const cPast = m.get(ms - 3 * M15);
      if (cNow == null || cPast == null || cPast === 0) continue;
      const mv = (cNow - cPast) / cPast;
      const [base, quote] = inst.split('_');
      sums[base]  = (sums[base]  || 0) + mv; counts[base]  = (counts[base]  || 0) + 1;
      sums[quote] = (sums[quote] || 0) - mv; counts[quote] = (counts[quote] || 0) + 1;
    }
    // Require a reasonable spread of pairs per currency
    const norm = {};
    for (const c of CURRENCIES) {
      if (!counts[c] || counts[c] < 3) return null;
      norm[c] = sums[c] / counts[c];
    }
    return norm;
  }

  const out = [];
  let skippedExisting = 0, skippedData = 0;
  for (const ms of times) {
    if (existing.has(ms)) { skippedExisting++; continue; }
    const cur = normAt(ms);
    if (!cur) { skippedData++; continue; }
    const prev = normAt(ms - M15);
    const values = {};
    for (const c of CURRENCIES) {
      values[c] = prev ? (prev[c] + cur[c]) / 2 : cur[c];   // same EMA as live
    }
    out.push({ time: new Date(ms).toISOString(), values });
  }
  console.log(`${out.length} rows to write (${skippedExisting} already archived, ${skippedData} insufficient data)`);

  if (DRY) {
    for (const r of out.slice(0, 5)) console.log(' ', r.time, JSON.stringify(r.values).slice(0, 120));
    console.log('Dry run — nothing written.');
    return;
  }

  let written = 0;
  for (let i = 0; i < out.length; i += 500) {
    const batch = out.slice(i, i + 500);
    const { error } = await supabase
      .from('m15_currency_strength')
      .upsert(batch, { onConflict: 'time' });
    if (error) { console.error(`Batch at ${batch[0].time}:`, error.message); continue; }
    written += batch.length;
    if (written % 5000 < 500) console.log(`  …${written}/${out.length}`);
  }
  console.log(`Done — wrote ${written}/${out.length} rows`);
})();
