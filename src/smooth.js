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
      .select('id, time, normalized_2h, normalized_3h, normalized_4h, normalized_6h, normalized_12h, normalized_1d, smooth_2h, smooth_3h, smooth_4h, smooth_6h, smooth_12h, smooth_1d')
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
      smooth_2h: r.smooth_2h,
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

  let prev2h = null, prev3h = null, prev4h = null, prev6h = null, prev12h = null, prev1d = null;

  const toUpdate = [];

  for (const row of rows) {
    const s2h  = ema(prev2h,  parseFloat(row.normalized_2h) || 0);
    const s3h  = ema(prev3h,  row.normalized_3h);
    const s4h  = ema(prev4h,  parseFloat(row.normalized_4h) || 0);
    const s6h  = ema(prev6h,  row.normalized_6h);
    const s12h = ema(prev12h, row.normalized_12h);
    const s1d  = ema(prev1d,  parseFloat(row.normalized_1d) || 0);

    toUpdate.push({ ...row, currency, smooth_2h: s2h, smooth_3h: s3h, smooth_4h: s4h, smooth_6h: s6h, smooth_12h: s12h, smooth_1d: s1d });

    prev2h = s2h; prev3h = s3h; prev4h = s4h; prev6h = s6h; prev12h = s12h; prev1d = s1d;
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

// Smooth all unsmoothed rows for each currency (handles gap backfills).
// Called after calculateLatestStrength() in the hourly update.
async function smoothLatest() {
  const allUpdates = [];

  for (const currency of CURRENCIES) {
    const { data: unsmoothed, error } = await supabase
      .from('currency_strength')
      .select('id, time, normalized_2h, normalized_3h, normalized_4h, normalized_6h, normalized_12h, normalized_1d')
      .eq('currency', currency)
      .is('smooth_2h', null)
      .order('time', { ascending: true })
      .limit(50);

    if (error) throw new Error(`Fetch unsmoothed error (${currency}): ${error.message}`);
    if (!unsmoothed?.length) continue;

    const { data: prev } = await supabase
      .from('currency_strength')
      .select('smooth_2h, smooth_3h, smooth_4h, smooth_6h, smooth_12h, smooth_1d')
      .eq('currency', currency)
      .lt('time', unsmoothed[0].time)
      .not('smooth_3h', 'is', null)
      .order('time', { ascending: false })
      .limit(1);

    let p2 = prev?.[0]?.smooth_2h ?? null;
    let p3 = prev?.[0]?.smooth_3h ?? null;
    let p4 = prev?.[0]?.smooth_4h ?? null;
    let p6 = prev?.[0]?.smooth_6h ?? null;
    let p12 = prev?.[0]?.smooth_12h ?? null;
    let p1d = prev?.[0]?.smooth_1d ?? null;

    for (const row of unsmoothed) {
      p2  = ema(p2,  parseFloat(row.normalized_2h) || 0);
      p3  = ema(p3,  row.normalized_3h);
      p4  = ema(p4,  parseFloat(row.normalized_4h) || 0);
      p6  = ema(p6,  row.normalized_6h);
      p12 = ema(p12, row.normalized_12h);
      p1d = ema(p1d, parseFloat(row.normalized_1d) || 0);
      allUpdates.push({
        id: row.id, time: row.time, currency,
        smooth_2h: p2, smooth_3h: p3, smooth_4h: p4, smooth_6h: p6,
        smooth_12h: p12, smooth_1d: p1d,
      });
    }
  }

  await batchUpdateSmooth(allUpdates);
  const hours = allUpdates.length / 8;
  console.log(`[SMOOTH] Smoothed ${allUpdates.length} rows (${hours} hour${hours > 1 ? 's' : ''})`);
  return allUpdates;
}

module.exports = { backfillSmooth, smoothLatest, smoothCurrency };
