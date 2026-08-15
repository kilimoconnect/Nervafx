'use strict';

/**
 * NervaFX Liquidity Failure Engine — as-of candle access.
 *
 * The single place the closed-candle rule is enforced: a candle open at t on a
 * timeframe of tfMs is usable only when its CLOSE (t + tfMs) is ≤ the evaluation
 * time. The forming candle is always excluded. Everything downstream receives
 * only completed candles, so no detector can look ahead.
 */

const { HOUR_MS, M15_MS, DAY_MS, FETCH_LIMITS } = require('./_lfe-constants');
// _db (and its @supabase dep) is required lazily so the pure helpers here can be
// unit-tested without the Supabase client installed.

/**
 * Pure closed-candle filter. Maps raw rows to the engine candle shape, keeps
 * only candles closed by evalMs, de-dupes by open time, sorts ascending.
 */
function filterClosedCandles(rows, evalMs, tfMs) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const openMs = new Date(r.time).getTime();
    if (!Number.isFinite(openMs)) continue;
    if (openMs + tfMs > evalMs) continue;      // not yet closed at evalMs
    if (seen.has(openMs)) continue;
    seen.add(openMs);
    out.push({ openMs, time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close });
  }
  out.sort((a, b) => a.openMs - b.openMs);
  return out;
}

async function fetchClosed(sb, inst, timeframe, evalMs, tfMs, limit) {
  const client = sb || require('./_db').getClient();
  const untilISO = new Date(evalMs - tfMs).toISOString();   // open ≤ evalMs - tf  ⇒  close ≤ evalMs
  const { data, error } = await client
    .from('backtest_candles')
    .select('time, open, high, low, close')
    .eq('instrument', inst).eq('timeframe', timeframe).eq('complete', true)
    .lte('time', untilISO)
    .order('time', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return filterClosedCandles(data || [], evalMs, tfMs);
}

/** Fetch H1 + M15 + D1 for one pair, all bounded to completed candles ≤ evalMs. */
async function fetchPairData(sb, pair, evalMs) {
  const [h1, m15, d1] = await Promise.all([
    fetchClosed(sb, pair, 'H1', evalMs, HOUR_MS, FETCH_LIMITS.h1),
    fetchClosed(sb, pair, 'M15', evalMs, M15_MS, FETCH_LIMITS.m15),
    fetchClosed(sb, pair, 'D1', evalMs, DAY_MS, FETCH_LIMITS.d1),
  ]);
  return { h1, m15, d1 };
}

module.exports = { filterClosedCandles, fetchClosed, fetchPairData };
