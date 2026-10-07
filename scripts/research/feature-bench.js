'use strict';

/**
 * Stage 2 perf/representative-slice bench (read-only). Loads a bounded recent
 * window, times ONE full 28-pair feature snapshot (with and without descriptors),
 * and a replay slice of the last ~200 completed closes. No writes.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { M15, PAIRS, loadAllPairsFromDb, replay } = require('../../research/m15/loader');
const { featureSnapshot } = require('../../research/m15/featureSnapshot');

function env() { const t = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8'); const e = {}; for (const l of t.split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); } return e; }

async function main() {
  const e = env(); const sb = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY);
  const days = parseInt(process.argv[2] || '40', 10);
  const toIso = '2026-09-26T00:00:00Z';                       // just after last data
  const fromMs = Date.parse(toIso) - days * 24 * 3600e3;
  const fromIso = new Date(fromMs).toISOString();
  console.error(`loading ${days}d ${fromIso}..${toIso} …`);
  const t0 = Date.now();
  const hist = await loadAllPairsFromDb(sb, { fromIso, toIso });
  const loadMs = Date.now() - t0;
  const counts = PAIRS.map((p) => hist[p].length);
  const lastOpen = Math.max(...PAIRS.map((p) => hist[p].length ? hist[p][hist[p].length - 1].openMs : 0));
  const T = lastOpen + M15;                                   // evaluation close after the last candle

  // one full snapshot (features only, then with descriptors)
  let s0 = process.hrtime.bigint(); const snap = featureSnapshot(hist, T); let snapMs = Number(process.hrtime.bigint() - s0) / 1e6;
  s0 = process.hrtime.bigint(); featureSnapshot(hist, T, { descriptors: true }); const snapDescMs = Number(process.hrtime.bigint() - s0) / 1e6;

  // replay slice: last ~200 completed closes
  const slice = 200; const from = lastOpen - (slice - 1) * M15 + M15;
  s0 = process.hrtime.bigint(); let processed = 0;
  const r = replay(hist, { fromCloseMs: from, toCloseMs: T, warmupCandles: 20, onClose: (t) => { featureSnapshot(hist, t); processed++; } });
  const replayMs = Number(process.hrtime.bigint() - s0) / 1e6;

  const eurusd = snap.pairs['EUR_USD'];
  const out = {
    window: { days, candlesPerPairMin: Math.min(...counts), candlesPerPairMax: Math.max(...counts) },
    timings: {
      dbLoadMs: loadMs,
      oneSnapshotMs: +snapMs.toFixed(1),
      oneSnapshotWithDescriptorsMs: +snapDescMs.toFixed(1),
      replayCloses: r.processed, replayTotalMs: +replayMs.toFixed(0), replayPerCloseMs: +(replayMs / Math.max(1, r.processed)).toFixed(2),
    },
    sampleSnapshot: { close: snap.closeIso, session: snap.session, aligned: snap.aligned, featureVersion: snap.featureVersion, inputHash: snap.inputHash,
      EUR_USD_R: { 4: eurusd.horizons[4] && +eurusd.horizons[4].R.toFixed(6), 10: eurusd.horizons[10] && +eurusd.horizons[10].R.toFixed(6) },
      EUR_USD_P10: eurusd.horizons[10] && +eurusd.horizons[10].P.toFixed(1),
      EUR_USD_z10: eurusd.horizons[10] && eurusd.horizons[10].z,
      network10_zeroSum: snap.network[10].zeroSum, gap_EUR_USD_10: +snap.network[10].gap['EUR_USD'].toFixed(6) },
  };
  fs.mkdirSync(path.join(__dirname, '..', '..', 'docs', 'research'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '..', 'docs', 'research', 'stage2_bench.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error('BENCH ERR', e.message); process.exit(1); });
