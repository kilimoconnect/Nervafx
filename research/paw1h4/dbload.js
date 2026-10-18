'use strict';

/**
 * Read-only loader: fetch stored H1 candles from Supabase `backtest_candles` for a
 * set of instruments. We aggregate H4/W1 from these (see aggregate.js); we never
 * write, migrate, or modify production data here.
 */

const { H1_MS } = require('./config');

async function loadH1(sb, pairs, opts = {}) {
  const out = {};
  for (const p of pairs) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
      let q = sb.from('backtest_candles')
        .select('time,open,high,low,close,volume')
        .eq('instrument', p).eq('timeframe', 'H1').eq('complete', true)
        .order('time', { ascending: true }).range(off, off + 999);
      if (opts.fromIso) q = q.gte('time', opts.fromIso);
      if (opts.toIso) q = q.lte('time', opts.toIso);
      const { data, error } = await q;
      if (error) throw new Error(`${p}: ${error.message}`);
      if (!data || !data.length) break;
      for (const r of data) rows.push({ openMs: Date.parse(r.time), closeMs: Date.parse(r.time) + H1_MS, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: r.volume });
      if (data.length < 1000) break;
    }
    out[p] = rows;
  }
  return out;
}

/** Parallel variant: fetch several instruments concurrently (default 8 at a time). */
async function loadH1Parallel(sb, pairs, opts = {}, concurrency = 8) {
  const out = {};
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((p) => loadH1(sb, [p], opts).then((r) => [p, r[p]])));
    for (const [p, rows] of res) out[p] = rows;
  }
  return out;
}

module.exports = { loadH1, loadH1Parallel };
