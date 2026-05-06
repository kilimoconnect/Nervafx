const { config } = require('./config');
const { supabase } = require('./supabase');

// Fetch all currency_strength rows with smooth values into a lookup.
// Returns: { '2026-05-06T17:00:00.000Z': { USD: { s3h, s6h, s12h }, EUR: {...}, ... }, ... }
async function buildStrengthLookup() {
  const lookup = {};

  for (const currency of ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']) {
    const { data, error } = await supabase
      .from('currency_strength')
      .select('time, smooth_3h, smooth_6h, smooth_12h')
      .eq('currency', currency)
      .not('smooth_3h', 'is', null)
      .order('time', { ascending: true });

    if (error) throw new Error(`Strength fetch error (${currency}): ${error.message}`);

    for (const row of data || []) {
      const t = new Date(row.time).toISOString();
      if (!lookup[t]) lookup[t] = {};
      lookup[t][currency] = {
        s3h: parseFloat(row.smooth_3h),
        s6h: parseFloat(row.smooth_6h),
        s12h: parseFloat(row.smooth_12h),
      };
    }
  }

  return lookup;
}

// Compute 28 spread rows for one timestamp given a strength snapshot.
// snapshot: { USD: { s3h, s6h, s12h }, EUR: {...}, ... }
function computeSpreads(time, snapshot) {
  const rows = [];

  for (const instrument of config.instruments) {
    const [base, quote] = instrument.split('_');
    const b = snapshot[base];
    const q = snapshot[quote];
    if (!b || !q) return null;

    rows.push({
      time,
      instrument,
      base_currency: base,
      quote_currency: quote,
      spread_3h: b.s3h - q.s3h,
      spread_6h: b.s6h - q.s6h,
      spread_12h: b.s12h - q.s12h,
    });
  }

  return rows;
}

async function upsertSpreads(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('pair_strength_spreads')
    .upsert(rows, { onConflict: 'time,instrument', ignoreDuplicates: false });
  if (error) throw new Error(`Spread upsert error: ${error.message}`);
}

// Backfill spreads for all historical timestamps.
async function backfillSpreads() {
  console.log('[SPREAD] Building strength lookup...');
  const lookup = await buildStrengthLookup();
  const timestamps = Object.keys(lookup).sort();
  console.log(`[SPREAD] ${timestamps.length} timestamps with smooth strength data`);

  let calculated = 0;
  let skipped = 0;
  const BATCH = 50;
  let batch = [];

  for (const time of timestamps) {
    const snapshot = lookup[time];
    const allCurrencies = Object.keys(snapshot).length === 8;
    if (!allCurrencies) { skipped++; continue; }

    const rows = computeSpreads(time, snapshot);
    if (!rows) { skipped++; continue; }

    batch.push(...rows);

    if (batch.length >= BATCH * 28) {
      await upsertSpreads(batch);
      calculated += batch.length / 28;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await upsertSpreads(batch);
    calculated += batch.length / 28;
  }

  console.log(`[SPREAD] Backfill done. Calculated: ${calculated}, Skipped: ${skipped}`);
  return { calculated, skipped };
}

// Calculate and store spreads for the latest timestamp only.
async function calculateLatestSpreads() {
  const { data, error } = await supabase
    .from('currency_strength')
    .select('time, currency, smooth_3h, smooth_6h, smooth_12h')
    .not('smooth_3h', 'is', null)
    .order('time', { ascending: false })
    .limit(8);

  if (error) throw new Error(`Latest strength fetch error: ${error.message}`);
  if (!data || data.length < 8) throw new Error('Incomplete strength data for latest timestamp');

  const time = new Date(data[0].time).toISOString();
  const snapshot = {};
  for (const row of data) {
    snapshot[row.currency] = {
      s3h: parseFloat(row.smooth_3h),
      s6h: parseFloat(row.smooth_6h),
      s12h: parseFloat(row.smooth_12h),
    };
  }

  const rows = computeSpreads(time, snapshot);
  if (!rows) throw new Error('Could not compute spreads — missing currency data');

  await upsertSpreads(rows);
  console.log(`[SPREAD] Stored 28 spreads for ${time}`);
  return { time, rows };
}

// Rank pairs by absolute spread_6h for a given time (default: latest).
async function rankPairs(time) {
  let query = supabase
    .from('pair_strength_spreads')
    .select('instrument, base_currency, quote_currency, spread_3h, spread_6h, spread_12h');

  if (time) {
    query = query.eq('time', time);
  } else {
    const { data: latest } = await supabase
      .from('pair_strength_spreads')
      .select('time')
      .order('time', { ascending: false })
      .limit(1);
    if (!latest || latest.length === 0) return [];
    query = query.eq('time', latest[0].time);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Rank fetch error: ${error.message}`);

  return (data || [])
    .map(r => ({
      ...r,
      abs_spread_6h: Math.abs(parseFloat(r.spread_6h)),
      bias: parseFloat(r.spread_6h) >= 0 ? 'BUY' : 'SELL',
    }))
    .sort((a, b) => b.abs_spread_6h - a.abs_spread_6h);
}

module.exports = { backfillSpreads, calculateLatestSpreads, rankPairs, computeSpreads };
