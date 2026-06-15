const { config } = require('./config');
const { supabase } = require('./supabase');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const PAIRS_PER_CURRENCY = 7;
const LOOKBACKS = [3, 4, 6, 12, 24];

function offsetISO(isoTime, hoursBack) {
  const t = new Date(isoTime);
  t.setUTCHours(t.getUTCHours() - hoursBack);
  return t.toISOString();
}

// Fetch all H1 candles for all instruments into a fast in-memory lookup.
// Uses pagination (PAGE_SIZE rows at a time) to avoid Supabase's 1000-row default cap.
// Returns: { EUR_USD: { '2026-05-06T10:00:00.000Z': 1.0842, ... }, ... }
const PAGE_SIZE = 1000;

async function buildCandleLookup() {
  const lookup = {};

  for (const instrument of config.instruments) {
    lookup[instrument] = {};
    let page = 0;

    while (true) {
      const from = page * PAGE_SIZE;
      const to   = from + PAGE_SIZE - 1;

      const { data, error } = await supabase
        .from('backtest_candles')
        .select('time, close')
        .eq('instrument', instrument)
        .eq('timeframe', config.granularity)
        .eq('complete', true)
        .order('time', { ascending: true })
        .range(from, to);

      if (error) throw new Error(`Candle fetch error (${instrument}): ${error.message}`);
      if (!data || data.length === 0) break;

      for (const c of data) {
        lookup[instrument][new Date(c.time).toISOString()] = parseFloat(c.close);
      }

      if (data.length < PAGE_SIZE) break; // last page
      page++;
    }
  }

  return lookup;
}

// Fetch only the most recent N candles per instrument — sufficient for calculateLatestStrength()
// 12H lookback + up to ~24H lag in latestCommonTime + buffer = 50 rows minimum.
async function buildRecentCandleLookup(recentCount = 50) {
  const lookup = {};

  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, close')
      .eq('instrument', instrument)
      .eq('timeframe', config.granularity)
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(recentCount);

    if (error) throw new Error(`Candle fetch error (${instrument}): ${error.message}`);

    lookup[instrument] = {};
    for (const c of data || []) {
      lookup[instrument][new Date(c.time).toISOString()] = parseFloat(c.close);
    }
  }

  return lookup;
}

// Find the latest time that all 28 instruments share.
// Sorts keys so this works whether the lookup was built ascending or descending.
function latestCommonTime(lookup) {
  let common = null;
  for (const instrument of config.instruments) {
    const times = Object.keys(lookup[instrument] || {}).sort(); // sort ascending
    if (times.length === 0) return null;
    const latest = times[times.length - 1]; // last = newest
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
  const raw = {};
  for (const lb of LOOKBACKS) raw[lb] = Object.fromEntries(CURRENCIES.map(c => [c, 0]));

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
    raw_4h: raw[4][currency],
    raw_6h: raw[6][currency],
    raw_12h: raw[12][currency],
    raw_1d: raw[24][currency],
    normalized_3h: raw[3][currency] / PAIRS_PER_CURRENCY,
    normalized_4h: raw[4][currency] / PAIRS_PER_CURRENCY,
    normalized_6h: raw[6][currency] / PAIRS_PER_CURRENCY,
    normalized_12h: raw[12][currency] / PAIRS_PER_CURRENCY,
    normalized_1d: raw[24][currency] / PAIRS_PER_CURRENCY,
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
// Uses positional (candle-count) lookbacks — no calendar-hour arithmetic.
// "3H" = 3 completed H1 candles back. Weekend gaps are invisible because
// there are no candles then; the 12th candle from Monday morning is Friday.
async function calculateLatestStrength() {
  const MAX_LB = Math.max(...LOOKBACKS);
  const FETCH  = MAX_LB + 26;
  const MIN_CANDLES = MAX_LB + 1;

  const arrays = {};
  for (const instrument of config.instruments) {
    const { data, error } = await supabase
      .from('backtest_candles')
      .select('time, close')
      .eq('instrument', instrument)
      .eq('timeframe', config.granularity)
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(FETCH);
    if (error) throw new Error(`Candle fetch error (${instrument}): ${error.message}`);
    if (!data || data.length < MIN_CANDLES)
      throw new Error(`[STRENGTH] Not enough candles for ${instrument}: need ${MIN_CANDLES}, got ${data?.length ?? 0}`);
    arrays[instrument] = data.map(c => ({ time: new Date(c.time).toISOString(), close: parseFloat(c.close) }));
  }

  let common = new Set(arrays[config.instruments[0]].map(c => c.time));
  for (let i = 1; i < config.instruments.length; i++) {
    const s = new Set(arrays[config.instruments[i]].map(c => c.time));
    common = new Set([...common].filter(t => s.has(t)));
  }
  const commonTimes = [...common].sort();
  if (!commonTimes.length) throw new Error('[STRENGTH] No common timestamps');

  const { data: existing } = await supabase
    .from('currency_strength')
    .select('time')
    .in('time', commonTimes)
    .eq('currency', 'USD');
  const filled = new Set((existing || []).map(r => new Date(r.time).toISOString()));

  const latest = commonTimes[commonTimes.length - 1];
  const toCalc = commonTimes.filter(t => !filled.has(t) || t === latest);

  let gapsFilled = 0;
  for (const refTime of toCalc) {
    const raw = {};
    for (const lb of LOOKBACKS) raw[lb] = Object.fromEntries(CURRENCIES.map(c => [c, 0]));

    let ok = true;
    for (const instrument of config.instruments) {
      const arr = arrays[instrument];
      const [base, quote] = instrument.split('_');
      const refIdx = arr.findIndex(c => c.time <= refTime);
      if (refIdx === -1) { ok = false; break; }
      const closeNow = arr[refIdx].close;
      for (const lb of LOOKBACKS) {
        if (refIdx + lb >= arr.length) { ok = false; break; }
        const mv = (closeNow - arr[refIdx + lb].close) / arr[refIdx + lb].close;
        raw[lb][base] += mv;
        raw[lb][quote] -= mv;
      }
      if (!ok) break;
    }
    if (!ok) continue;

    const rows = CURRENCIES.map(currency => ({
      time: refTime, currency,
      raw_3h:  raw[3][currency],  raw_4h:  raw[4][currency],
      raw_6h:  raw[6][currency],  raw_12h: raw[12][currency],
      raw_1d:  raw[24][currency],
      normalized_3h:  raw[3][currency]  / PAIRS_PER_CURRENCY,
      normalized_4h:  raw[4][currency]  / PAIRS_PER_CURRENCY,
      normalized_6h:  raw[6][currency]  / PAIRS_PER_CURRENCY,
      normalized_12h: raw[12][currency] / PAIRS_PER_CURRENCY,
      normalized_1d:  raw[24][currency] / PAIRS_PER_CURRENCY,
    }));

    await upsertStrengthRows(rows);
    if (!filled.has(refTime)) gapsFilled++;
  }

  if (gapsFilled > 0) console.log(`[STRENGTH] Backfilled ${gapsFilled} missing hours`);
  console.log(`[STRENGTH] Latest: ${latest}`);
  return { time: latest, rows: [], gapsFilled };
}

module.exports = { backfillStrength, calculateLatestStrength, buildCandleLookup, buildRecentCandleLookup, calculateAtTime };
