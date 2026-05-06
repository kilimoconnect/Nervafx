const { supabase } = require('./supabase');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

function ema(prevSmooth, currentNorm) {
  if (prevSmooth === null || prevSmooth === undefined) return currentNorm;
  return (prevSmooth + currentNorm) / 2;
}

// Fetch all currency_strength rows for one currency, ordered ascending.
async function getRowsForCurrency(currency) {
  const { data, error } = await supabase
    .from('currency_strength')
    .select('id, time, normalized_3h, normalized_6h, normalized_12h, smooth_3h, smooth_6h, smooth_12h')
    .eq('currency', currency)
    .order('time', { ascending: true });

  if (error) throw new Error(`Fetch error (${currency}): ${error.message}`);
  return data || [];
}

// Batch update smooth columns for a set of rows.
async function batchUpdateSmooth(rows) {
  if (rows.length === 0) return;

  const updates = rows.map(r => ({
    id: r.id,
    time: r.time,
    currency: r.currency,
    smooth_3h: r.smooth_3h,
    smooth_6h: r.smooth_6h,
    smooth_12h: r.smooth_12h,
  }));

  const { error } = await supabase
    .from('currency_strength')
    .upsert(updates, { onConflict: 'id' });

  if (error) throw new Error(`Smooth update error: ${error.message}`);
}

// Backfill smooth values for all historical rows of one currency.
async function smoothCurrency(currency) {
  const rows = await getRowsForCurrency(currency);
  if (rows.length === 0) return 0;

  let prev3h = null;
  let prev6h = null;
  let prev12h = null;

  const toUpdate = [];

  for (const row of rows) {
    const s3h = ema(prev3h, row.normalized_3h);
    const s6h = ema(prev6h, row.normalized_6h);
    const s12h = ema(prev12h, row.normalized_12h);

    toUpdate.push({ ...row, currency, smooth_3h: s3h, smooth_6h: s6h, smooth_12h: s12h });

    prev3h = s3h;
    prev6h = s6h;
    prev12h = s12h;
  }

  await batchUpdateSmooth(toUpdate);
  return toUpdate.length;
}

// Backfill smoothing for all 8 currencies.
async function backfillSmooth() {
  console.log('[SMOOTH] Starting backfill smoothing for all currencies...');
  let total = 0;

  for (const currency of CURRENCIES) {
    const count = await smoothCurrency(currency);
    console.log(`[SMOOTH] ${currency}: smoothed ${count} rows`);
    total += count;
  }

  console.log(`[SMOOTH] Backfill done. Total rows smoothed: ${total}`);
  return { total };
}

// Apply smoothing to the latest row for each currency.
// Called after calculateLatestStrength() in the hourly update.
async function smoothLatest() {
  const updates = [];

  for (const currency of CURRENCIES) {
    const { data, error } = await supabase
      .from('currency_strength')
      .select('id, time, currency, normalized_3h, normalized_6h, normalized_12h')
      .eq('currency', currency)
      .order('time', { ascending: false })
      .limit(2);

    if (error) throw new Error(`Fetch latest error (${currency}): ${error.message}`);
    if (!data || data.length === 0) continue;

    const current = data[0];
    const previous = data[1] || null;

    let prev3h = null;
    let prev6h = null;
    let prev12h = null;

    if (previous) {
      const { data: prevRow } = await supabase
        .from('currency_strength')
        .select('smooth_3h, smooth_6h, smooth_12h')
        .eq('id', previous.id)
        .single();

      if (prevRow) {
        prev3h = prevRow.smooth_3h;
        prev6h = prevRow.smooth_6h;
        prev12h = prevRow.smooth_12h;
      }
    }

    updates.push({
      id: current.id,
      time: current.time,
      currency,
      smooth_3h: ema(prev3h, current.normalized_3h),
      smooth_6h: ema(prev6h, current.normalized_6h),
      smooth_12h: ema(prev12h, current.normalized_12h),
    });
  }

  await batchUpdateSmooth(updates);
  console.log(`[SMOOTH] Latest smoothing applied for ${updates.length} currencies`);
  return updates;
}

module.exports = { backfillSmooth, smoothLatest, smoothCurrency };
