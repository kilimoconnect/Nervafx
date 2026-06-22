'use strict';

// Backfill currency_strength gaps using positional lookbacks (candle-count)
// instead of calendar-hour offsets. Fixes DST/weekend boundary gaps.

require('dotenv').config();
const { supabase } = require('../src/supabase');
const { config } = require('../src/config');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const PAIRS_PER_CURRENCY = 7;
const LOOKBACKS = [2, 3, 4, 6, 12, 24];

async function run() {
  // 1. Find all H1 timestamps that have candles but no currency_strength
  console.log('[BACKFILL] Fetching all H1 candle times...');
  const candleTimes = new Set();
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time')
      .eq('instrument', 'EUR_USD')
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    data.forEach(r => candleTimes.add(new Date(r.time).toISOString()));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`[BACKFILL] ${candleTimes.size} H1 timestamps found`);

  console.log('[BACKFILL] Fetching existing currency_strength times...');
  const existingTimes = new Set();
  offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('currency_strength')
      .select('time')
      .eq('currency', 'USD')
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    data.forEach(r => existingTimes.add(new Date(r.time).toISOString()));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`[BACKFILL] ${existingTimes.size} existing strength rows`);

  const missing = [...candleTimes].filter(t => !existingTimes.has(t)).sort();
  console.log(`[BACKFILL] ${missing.length} missing timestamps to fill`);
  if (!missing.length) return;

  // 2. Build candle lookup (positional — array of {time, close} sorted ascending per instrument)
  console.log('[BACKFILL] Building candle arrays...');
  const candleArrays = {};
  for (const instrument of config.instruments) {
    const allCandles = [];
    let off = 0;
    while (true) {
      const { data, error } = await supabase
        .from('backtest_candles')
        .select('time, close')
        .eq('instrument', instrument)
        .eq('timeframe', 'H1')
        .eq('complete', true)
        .order('time', { ascending: true })
        .range(off, off + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      allCandles.push(...data.map(c => ({ time: new Date(c.time).toISOString(), close: parseFloat(c.close) })));
      if (data.length < PAGE) break;
      off += PAGE;
    }
    candleArrays[instrument] = allCandles;
  }

  // Build index: time -> position in array per instrument
  const candleIndex = {};
  for (const instrument of config.instruments) {
    candleIndex[instrument] = {};
    candleArrays[instrument].forEach((c, i) => {
      candleIndex[instrument][c.time] = i;
    });
  }

  // 3. For each missing time, compute strength using positional lookback
  let filled = 0;
  let skipped = 0;
  const BATCH_SIZE = 100;
  let batch = [];

  for (const time of missing) {
    const raw = {};
    for (const lb of LOOKBACKS) raw[lb] = Object.fromEntries(CURRENCIES.map(c => [c, 0]));

    let valid = true;
    for (const instrument of config.instruments) {
      const idx = candleIndex[instrument][time];
      if (idx === undefined) { valid = false; break; }

      const [base, quote] = instrument.split('_');
      const closeNow = candleArrays[instrument][idx].close;

      for (const lb of LOOKBACKS) {
        const pastIdx = idx - lb;
        if (pastIdx < 0) { valid = false; break; }
        const pastClose = candleArrays[instrument][pastIdx].close;
        const movement = (closeNow - pastClose) / pastClose;
        raw[lb][base] += movement;
        raw[lb][quote] -= movement;
      }
      if (!valid) break;
    }

    if (!valid) { skipped++; continue; }

    const rows = CURRENCIES.map(currency => ({
      time,
      currency,
      raw_2h: raw[2][currency],
      raw_3h: raw[3][currency],
      raw_4h: raw[4][currency],
      raw_6h: raw[6][currency],
      raw_12h: raw[12][currency],
      raw_1d: raw[24][currency],
      normalized_2h: raw[2][currency] / PAIRS_PER_CURRENCY,
      normalized_3h: raw[3][currency] / PAIRS_PER_CURRENCY,
      normalized_4h: raw[4][currency] / PAIRS_PER_CURRENCY,
      normalized_6h: raw[6][currency] / PAIRS_PER_CURRENCY,
      normalized_12h: raw[12][currency] / PAIRS_PER_CURRENCY,
      normalized_1d: raw[24][currency] / PAIRS_PER_CURRENCY,
    }));

    batch.push(...rows);
    if (batch.length >= BATCH_SIZE * CURRENCIES.length) {
      const { error } = await supabase
        .from('currency_strength')
        .upsert(batch, { onConflict: 'time,currency', ignoreDuplicates: false });
      if (error) throw error;
      filled += batch.length / CURRENCIES.length;
      console.log(`[BACKFILL] Filled ${filled} timestamps...`);
      batch = [];
    }
  }

  if (batch.length) {
    const { error } = await supabase
      .from('currency_strength')
      .upsert(batch, { onConflict: 'time,currency', ignoreDuplicates: false });
    if (error) throw error;
    filled += batch.length / CURRENCIES.length;
  }

  console.log(`[BACKFILL] Done. Filled: ${filled}, Skipped: ${skipped}`);

  // 4. Re-run smooth for all currencies
  console.log('[BACKFILL] Re-smoothing all currencies...');
  const { backfillSmooth } = require('../src/smooth');
  await backfillSmooth();
  console.log('[BACKFILL] Smooth complete.');
}

run().catch(e => { console.error(e); process.exit(1); });
