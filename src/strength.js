const { config } = require('./config');
const { supabase } = require('./supabase');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const PAIRS_PER_CURRENCY = 7;
const LOOKBACKS = [3, 6, 12];

function offsetISO(isoTime, hoursBack) {
  const t = new Date(isoTime);
  t.setUTCHours(t.getUTCHours() - hoursBack);
  return t.toISOString();
}

// Fetch all H1 candles for all instruments into a fast in-memory lookup.
// Fetches per instrument to avoid Supabase's 1000-row default cap.
// Returns: { EUR_USD: { '2026-05-06T10:00:00.000Z': 1.0842, ... }, ... }
async function buildCandleLookup() {
  const lookup = {};

  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('market_candles')
      .select('time, close')
      .eq('instrument', instrument)
      .eq('timeframe', config.granularity)
      .eq('complete', true)
      .order('time', { ascending: true });

    if (error) throw new Error(`Candle fetch error (${instrument}): ${error.message}`);

    lookup[instrument] = {};
    for (const c of data || []) {
      lookup[instrument][new Date(c.time).toISOString()] = parseFloat(c.close);
    }
  }

  return lookup;
}

// Find the latest time that all 28 instruments share.
function latestCommonTime(lookup) {
  let common = null;
  for (const instrument of config.instruments) {
    const times = Object.keys(lookup[instrument] || {});
    if (times.length === 0) return null;
    const latest = times[times.length - 1];
    if (!common || latest < common) common = latest;
  }
  return common;
}

// All H1 timestamps across the dataset, sorted ascending.
function allTimestamps(lookup) {
  const set = new Set();
  for (const instrument of config.instruments) {
    for (const t of Object.keys(lookup[instrument] || {})) {
      set.add(t);
    }
  }
  return [...set].sort();
}

// Calculate strength rows for a single H1 timestamp.
// Returns null if any required lookback candle is missing for any pair.
function calculateAtTime(lookup, time) {
  const raw = {
    3: Object.fromEntries(CURRENCIES.map(c => [c, 0])),
    6: Object.fromEntries(CURRENCIES.map(c => [c, 0])),
    12: Object.fromEntries(CURRENCIES.map(c => [c, 0])),
  };

  for (const instrument of config.instruments) {
    const [base, quote] = instrument.split('_');
    const instrData = lookup[instrument];
    if (!instrData) return null;

    const closeNow = instrData[time];
    if (closeNow === undefined) return null;

    for (const lb of LOOKBACKS) {
      const pastTime = offsetISO(time, lb);
      const pastClose = instrData[pastTime];
      if (pastClose === undefined) return null;

      const movement = (closeNow - pastClose) / pastClose;
      raw[lb][base] += movement;
      raw[lb][quote] -= movement;
    }
  }

  return CURRENCIES.map(currency => ({
    time,
    currency,
    raw_3h: raw[3][currency],
    raw_6h: raw[6][currency],
    raw_12h: raw[12][currency],
    normalized_3h: raw[3][currency] / PAIRS_PER_CURRENCY,
    normalized_6h: raw[6][currency] / PAIRS_PER_CURRENCY,
    normalized_12h: raw[12][currency] / PAIRS_PER_CURRENCY,
  }));
}

async function upsertStrengthRows(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('currency_strength')
    .upsert(rows, { onConflict: 'time,currency', ignoreDuplicates: false });
  if (error) throw new Error(`Strength upsert error: ${error.message}`);
}

// Backfill strength for all available historical candle times.
async function backfillStrength() {
  console.log('[STRENGTH] Building candle lookup...');
  const lookup = await buildCandleLookup();

  const timestamps = allTimestamps(lookup);
  console.log(`[STRENGTH] ${timestamps.length} unique H1 timestamps found`);

  let calculated = 0;
  let skipped = 0;
  const BATCH_SIZE = 100;
  let batch = [];

  for (const time of timestamps) {
    const rows = calculateAtTime(lookup, time);
    if (!rows) {
      skipped++;
      continue;
    }
    batch.push(...rows);
    if (batch.length >= BATCH_SIZE * CURRENCIES.length) {
      await upsertStrengthRows(batch);
      calculated += batch.length / CURRENCIES.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await upsertStrengthRows(batch);
    calculated += batch.length / CURRENCIES.length;
  }

  console.log(`[STRENGTH] Backfill done. Calculated: ${calculated}, Skipped (insufficient lookback): ${skipped}`);
  return { calculated, skipped };
}

// Calculate and store strength for the latest common closed candle only.
async function calculateLatestStrength() {
  const lookup = await buildCandleLookup();
  const time = latestCommonTime(lookup);

  if (!time) {
    throw new Error('[STRENGTH] No common candle time found across all instruments');
  }

  const rows = calculateAtTime(lookup, time);

  if (!rows) {
    throw new Error(`[STRENGTH] Missing lookback candles at ${time}. Cannot calculate.`);
  }

  await upsertStrengthRows(rows);
  console.log(`[STRENGTH] Stored 8 currency scores for ${time}`);
  return { time, rows };
}

module.exports = { backfillStrength, calculateLatestStrength, buildCandleLookup, calculateAtTime };
