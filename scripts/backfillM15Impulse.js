'use strict';

/**
 * Backfill impulse_score, impulse_dir, velocity, body_ratio, consec_dir
 * on existing m15_pair_spreads rows from backtest_candles M15 data.
 *
 * Usage: node scripts/backfillM15Impulse.js [days]
 */

require('dotenv').config();
const { supabase }    = require('../src/supabase');
const { config }      = require('../src/config');
const { computeImpulse, computeDE } = require('../src/m15');

const INSTRUMENTS = config.instruments;
const PAGE = 1000;

async function fetchAll(table, select, filters) {
  const all = [];
  let offset = 0;
  while (true) {
    let q = supabase.from(table).select(select).order('time', { ascending: true }).range(offset, offset + PAGE - 1);
    for (const [k, v] of Object.entries(filters)) {
      if (k === '_gte') q = q.gte(v[0], v[1]);
      else if (k === '_eq') q = q.eq(v[0], v[1]);
      else q = q.eq(k, v);
    }
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function run() {
  const days = parseInt(process.argv[2] || '30', 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[BACKFILL-IMPULSE] ${days} days from ${since}`);

  let totalUpdated = 0;

  for (const instrument of INSTRUMENTS) {
    // Fetch M15 candles for this instrument
    const candles = await fetchAll('backtest_candles',
      'time, open, high, low, close',
      { _gte: ['time', since], _eq: ['instrument', instrument], timeframe: 'M15', complete: true }
    );

    if (candles.length < 4) {
      console.log(`[BACKFILL-IMPULSE] ${instrument}: skip (${candles.length} candles)`);
      continue;
    }

    // Parse
    const parsed = candles.map(c => ({
      time:  c.time,
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
    }));

    // Fetch existing m15_pair_spreads rows for this instrument
    const spreadRows = await fetchAll('m15_pair_spreads',
      'id, time',
      { _gte: ['time', since], _eq: ['instrument', instrument] }
    );

    if (!spreadRows.length) {
      console.log(`[BACKFILL-IMPULSE] ${instrument}: no spread rows`);
      continue;
    }

    // For each spread row, find the candles up to that time and compute impulse
    const updates = [];
    for (const row of spreadRows) {
      const rowTime = new Date(row.time).getTime();
      // Get candles up to this time (last 20 for DE, last 4 for impulse)
      const relevant = parsed.filter(c => new Date(c.time).getTime() <= rowTime).slice(-20);
      if (relevant.length < 4) continue;

      const impulse = computeImpulse(relevant);
      const de = Math.round(computeDE(relevant) * 10) / 10;

      updates.push({
        id:             row.id,
        impulse_score:  impulse.impulse_score,
        impulse_dir:    impulse.impulse_dir,
        velocity:       impulse.velocity,
        body_ratio:     impulse.body_ratio,
        consec_dir:     impulse.consec_dir,
        de_combined:    de,
      });
    }

    // Upsert in batches
    for (let i = 0; i < updates.length; i += 500) {
      const batch = updates.slice(i, i + 500);
      const { error } = await supabase
        .from('m15_pair_spreads')
        .upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
      if (error) throw new Error(`${instrument} upsert: ${error.message}`);
    }

    totalUpdated += updates.length;
    console.log(`[BACKFILL-IMPULSE] ${instrument}: ${updates.length} rows updated`);
  }

  console.log(`[BACKFILL-IMPULSE] Complete: ${totalUpdated} rows`);
}

run().catch(e => { console.error('[BACKFILL-IMPULSE] FATAL:', e.message); process.exit(1); });
