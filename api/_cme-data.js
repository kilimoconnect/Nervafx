'use strict';

/**
 * NervaFX Currency Movement Engine — H1 + 15M candle access.
 *
 * Completed candles only (never the forming candle), deduped by timestamp,
 * sorted, malformed OHLC rejected, gaps flagged. Reuses the shared Supabase
 * client (lazy) and the backtest_candles source. Pure `filterClosed` is unit-
 * testable without the DB.
 */

const { HOUR_MS, M15_MS } = require('./_cme-constants');

function validOHLC(o, h, l, c) {
  if (![o, h, l, c].every(Number.isFinite)) return false;
  if (h < l) return false;
  if (h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9) return false;
  return true;
}

/** Pure closed-candle filter for one timeframe. */
function filterClosed(rows, evalMs, tfMs) {
  if (!Array.isArray(rows)) return { candles: [], rejected: 0, duplicates: 0, gaps: 0 };
  const seen = new Set();
  const out = [];
  let rejected = 0, duplicates = 0;
  for (const r of rows) {
    const openMs = new Date(r.time).getTime();
    if (!Number.isFinite(openMs)) { rejected += 1; continue; }
    if (openMs + tfMs > evalMs) continue;              // forming candle → excluded
    const o = +r.open, h = +r.high, l = +r.low, c = +r.close;
    if (!validOHLC(o, h, l, c)) { rejected += 1; continue; }
    if (seen.has(openMs)) { duplicates += 1; continue; }
    seen.add(openMs);
    out.push({ openMs, time: r.time, open: o, high: h, low: l, close: c });
  }
  out.sort((a, b) => a.openMs - b.openMs);
  let gaps = 0;
  for (let i = 1; i < out.length; i++) if (out[i].openMs - out[i - 1].openMs > tfMs) gaps += 1;
  return { candles: out, rejected, duplicates, gaps };
}

async function fetchClosed(sb, inst, timeframe, evalMs, tfMs, limit) {
  const client = sb || require('./_db').getClient();
  const untilISO = new Date(evalMs - tfMs).toISOString();  // open ≤ evalMs − tf ⇒ close ≤ evalMs
  const { data, error } = await client
    .from('backtest_candles')
    .select('time, open, high, low, close')
    .eq('instrument', inst).eq('timeframe', timeframe).eq('complete', true)
    .lte('time', untilISO)
    .order('time', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return filterClosed(data || [], evalMs, tfMs);
}

/**
 * Fetch H1 + M15 for one pair (both completed-only), isolating failures at the
 * caller. Returns candle ARRAYS on `h1`/`m15` (what the evaluator consumes) plus
 * per-timeframe `meta` (counts, rejected, gaps).
 */
async function fetchPair(sb, pair, evalMs, opts) {
  opts = opts || {};
  const [h1r, m15r] = await Promise.all([
    fetchClosed(sb, pair, 'H1', evalMs, HOUR_MS, opts.h1Limit || 120),
    fetchClosed(sb, pair, 'M15', evalMs, M15_MS, opts.m15Limit || 400),
  ]);
  return {
    h1: h1r.candles,
    m15: m15r.candles,
    meta: {
      h1: { count: h1r.candles.length, rejected: h1r.rejected, gaps: h1r.gaps },
      m15: { count: m15r.candles.length, rejected: m15r.rejected, gaps: m15r.gaps },
    },
  };
}

module.exports = { validOHLC, filterClosed, fetchClosed, fetchPair };
