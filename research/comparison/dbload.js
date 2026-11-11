'use strict';

/** Read-only M15 loader for the Currency Comparison engine (backtest_candles,
 * completed candles only). Self-contained so the comparison system shares no code with
 * the retired analytical engines — only the raw market-candle table and its ingestion. */

const { M15_MS } = require('./config');

/** Load one timeframe (M15 or H1) for one instrument, completed candles only, ascending.
 *  Pass opts.withVolume to also select the volume column. */
async function loadTf(sb, instrument, timeframe, opts = {}) {
  const cols = opts.withVolume ? 'time,open,high,low,close,volume' : 'time,open,high,low,close';
  const rows = [];
  for (let off = 0; ; off += 1000) {
    let q = sb.from('backtest_candles').select(cols)
      .eq('instrument', instrument).eq('timeframe', timeframe).eq('complete', true)
      .order('time', { ascending: true }).range(off, off + 999);
    if (opts.fromIso) q = q.gte('time', opts.fromIso);
    if (opts.toIso) q = q.lte('time', opts.toIso);
    const { data, error } = await q;
    if (error) throw new Error(`${instrument} ${timeframe}: ${error.message}`);
    if (!data || !data.length) break;
    for (const r of data) { const row = { openMs: Date.parse(r.time), open: +r.open, high: +r.high, low: +r.low, close: +r.close }; if (opts.withVolume) row.volume = (r.volume == null ? null : +r.volume); rows.push(row); }
    if (data.length < 1000) break;
  }
  return rows;
}

async function loadParallel(sb, pairs, timeframe, opts = {}, concurrency = 8) {
  const out = {};
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((p) => loadTf(sb, p, timeframe, opts).then((rows) => [p, rows])));
    for (const [p, rows] of res) out[p] = rows;
  }
  return out;
}

const loadM5Parallel = (sb, pairs, opts, concurrency) => loadParallel(sb, pairs, 'M5', opts, concurrency);
const loadM15Parallel = (sb, pairs, opts, concurrency) => loadParallel(sb, pairs, 'M15', opts, concurrency);
const loadH1Parallel = (sb, pairs, opts, concurrency) => loadParallel(sb, pairs, 'H1', opts, concurrency);

module.exports = { loadTf, loadParallel, loadM5Parallel, loadM15Parallel, loadH1Parallel, M15_MS };
