const { supabase } = require('./supabase');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

function ema(prevSmooth, currentNorm) {
  if (prevSmooth === null || prevSmooth === undefined) return currentNorm;
  return (prevSmooth + currentNorm) / 2;
}

// Fetch all currency_strength rows for one currency, ordered ascending (paginated).
async function getRowsForCurrency(currency) {
  const PAGE = 1000;
  const allRows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('currency_strength')
      .select('id, time, normalized_3h, normalized_4h, normalized_6h, normalized_12h, normalized_1d, smooth_3h, smooth_4h, smooth_6h, smooth_12h, smooth_1d')
      .eq('currency', currency)
      .order('time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Fetch error (${currency}): ${error.message}`);
    if (!data || !data.length) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return allRows;
}

// Batch update smooth columns for a set of rows (paginated to avoid payload limits).
async function batchUpdateSmooth(rows) {
  if (rows.length === 0) return;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map(r => ({
      id: r.id,
      time: r.time,
      currency: r.currency,
      smooth_3h: r.smooth_3h,
      smooth_4h: r.smooth_4h,
      smooth_6h: r.smooth_6h,
      smooth_12h: r.smooth_12h,
      smooth_1d: r.smooth_1d,
    }));
    const { error } = await supabase
      .from('currency_strength')
      .upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(`Smooth update error: ${error.message}`);
  }
}

// Backfill smooth values for all historical rows of one currency.
async function smoothCurrency(currency) {
  const rows = await getRowsForCurrency(currency);
  if (rows.length === 0) return 0;

  let prev3h = null, prev4h = null, prev6h = null, prev12h = null, prev1d = null;

  const toUpdate = [];

  for (const row of rows) {
    const s3h  = ema(prev3h,  row.normalized_3h);
    const s4h  = ema(prev4h,  parseFloat(row.normalized_4h) || 0);
    const s6h  = ema(prev6h,  row.normalized_6h);
    const s12h = ema(prev12h, row.normalized_12h);
    const s1d  = ema(prev1d,  parseFloat(row.normalized_1d) || 0);

    toUpdate.push({ ...row, currency, smooth_3h: s3h, smooth_4h: s4h, smooth_6h: s6h, smooth_12h: s12h, smooth_1d: s1d });

    prev3h = s3h; prev4h = s4h; prev6h = s6h; prev12h = s12h; prev1d = s1d;
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
      .select('id, time, currency, normalized_3h, normalized_4h, normalized_6h, normalized_12h, normalized_1d')
      .eq('currency', currency)
      .order('time', { ascending: false })
      .limit(2);

    if (error) throw new Error(`Fetch latest error (${currency}): ${error.message}`);
    if (!data || data.length === 0) continue;

    const current = data[0];
    const previous = data[1] || null;

    let prev3h = null, prev4h = null, prev6h = null, prev12h = null, prev1d = null;

    if (previous) {
      const { data: prevRow } = await supabase
        .from('currency_strength')
        .select('smooth_3h, smooth_4h, smooth_6h, smooth_12h, smooth_1d')
        .eq('id', previous.id)
        .single();

      if (prevRow) {
        prev3h  = prevRow.smooth_3h;
        prev4h  = prevRow.smooth_4h;
        prev6h  = prevRow.smooth_6h;
        prev12h = prevRow.smooth_12h;
        prev1d  = prevRow.smooth_1d;
      }
    }

    updates.push({
      id: current.id,
      time: current.time,
      currency,
      smooth_3h:  ema(prev3h,  current.normalized_3h),
      smooth_4h:  ema(prev4h,  parseFloat(current.normalized_4h) || 0),
      smooth_6h:  ema(prev6h,  current.normalized_6h),
      smooth_12h: ema(prev12h, current.normalized_12h),
      smooth_1d:  ema(prev1d,  parseFloat(current.normalized_1d) || 0),
    });
  }

  await batchUpdateSmooth(updates);
  console.log(`[SMOOTH] Latest smoothing applied for ${updates.length} currencies`);
  return updates;
}

module.exports = { backfillSmooth, smoothLatest, smoothCurrency };
