'use strict';

/** Read-only M15 loader for the movement engine (backtest_candles, completed only). */
const { M15_MS } = require('./config');

async function loadM15(sb, pairs, opts = {}) {
  const out = {};
  for (const p of pairs) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
      let q = sb.from('backtest_candles').select('time,open,high,low,close')
        .eq('instrument', p).eq('timeframe', 'M15').eq('complete', true)
        .order('time', { ascending: true }).range(off, off + 999);
      if (opts.fromIso) q = q.gte('time', opts.fromIso);
      if (opts.toIso) q = q.lte('time', opts.toIso);
      const { data, error } = await q;
      if (error) throw new Error(`${p}: ${error.message}`);
      if (!data || !data.length) break;
      for (const r of data) rows.push({ openMs: Date.parse(r.time), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
      if (data.length < 1000) break;
    }
    out[p] = rows;
  }
  return out;
}

async function loadM15Parallel(sb, pairs, opts = {}, concurrency = 8) {
  const out = {};
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((p) => loadM15(sb, [p], opts).then((r) => [p, r[p]])));
    for (const [p, rows] of res) out[p] = rows;
  }
  return out;
}

module.exports = { loadM15, loadM15Parallel, M15_MS };
