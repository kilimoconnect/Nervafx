'use strict';

/**
 * Historical backfill — fetch 12 months of H1 and M15 candles from OANDA
 * and store in Supabase `backtest_candles` table.
 *
 * OANDA API limits: 5000 candles per request.
 *   H1  → ~6 240 candles/instrument/year  → 2 chunks
 *   M15 → ~24 960 candles/instrument/year → 5 chunks
 *
 * Usage:
 *   node src/backfill.js              # backfill both H1 and M15
 *   node src/backfill.js H1           # backfill H1 only
 *   node src/backfill.js M15          # backfill M15 only
 *   BACKFILL_MONTHS=6 node src/backfill.js   # override month range
 */

const { config, validate } = require('./config');
const { fetchCandles, sleep, RATE_LIMIT_DELAY } = require('./oanda');
const { supabase } = require('./supabase');

// ─── Config ──────────────────────────────────────────────────────────────────

const MONTHS        = parseInt(process.env.BACKFILL_MONTHS || '12', 10);
const OANDA_MAX     = 5000;
const BATCH_SIZE    = 500;  // upsert batch size to avoid payload limits
const RATE_MS       = 250;  // slightly conservative vs 200ms default

// Chunk durations (in ms) — stay well under 5000-candle OANDA limit
const CHUNK_MS = {
  H1:  180 * 24 * 60 * 60 * 1000, // 180 days ≈ 4 320 H1 candles
  M15:  45 * 24 * 60 * 60 * 1000, //  45 days ≈ 4 320 M15 candles (under 5000 limit)
  M5:   15 * 24 * 60 * 60 * 1000, //  15 days ≈ 4 320 M5 candles (under 5000 limit)
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseRawCandles(instrument, rawCandles, timeframe) {
  return rawCandles
    .filter(c => c.complete === true)
    .map(c => ({
      instrument,
      timeframe,
      time: c.time,
      open:   parseFloat(c.mid.o),
      high:   parseFloat(c.mid.h),
      low:    parseFloat(c.mid.l),
      close:  parseFloat(c.mid.c),
      volume: c.volume,
      complete: true,
      source: 'OANDA',
    }));
}

async function upsertBatched(candles) {
  let total = 0;
  for (let i = 0; i < candles.length; i += BATCH_SIZE) {
    const batch = candles.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('backtest_candles')
      .upsert(batch, { onConflict: 'instrument,timeframe,time', ignoreDuplicates: true });
    if (error) throw new Error(`Supabase upsert error: ${error.message}`);
    total += batch.length;
  }
  return total;
}

// ─── Core backfill ───────────────────────────────────────────────────────────

async function backfillInstrument(instrument, timeframe) {
  const now   = new Date();
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - MONTHS);

  const chunkMs = CHUNK_MS[timeframe];
  if (!chunkMs) throw new Error(`Unknown timeframe: ${timeframe}`);

  let from      = start.getTime();
  const endMs   = now.getTime();
  let totalRows = 0;
  let chunk     = 0;

  while (from < endMs) {
    chunk++;
    const to = Math.min(from + chunkMs, endMs);
    const fromISO = new Date(from).toISOString();
    const toISO   = new Date(to).toISOString();

    try {
      const raw = await fetchCandles(instrument, {
        from: fromISO,
        to:   toISO,
        granularity: timeframe,
      });
      await sleep(RATE_MS);

      const candles = parseRawCandles(instrument, raw, timeframe);

      if (candles.length > 0) {
        const inserted = await upsertBatched(candles);
        totalRows += inserted;
        console.log(`  [${timeframe}] ${instrument} chunk ${chunk}: ${candles.length} candles stored`);
      } else {
        console.log(`  [${timeframe}] ${instrument} chunk ${chunk}: 0 candles (weekend/gap)`);
      }
    } catch (err) {
      console.error(`  [${timeframe}] ${instrument} chunk ${chunk} ERROR: ${err.message}`);
      // Continue to next chunk — don't abort entire instrument
    }

    from = to;
  }

  return totalRows;
}

async function backfillAll(timeframes) {
  const instruments = config.instruments;
  const summary = {};

  for (const tf of timeframes) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  BACKFILL ${tf} — ${instruments.length} instruments × ${MONTHS} months`);
    console.log(`${'═'.repeat(60)}\n`);

    let grandTotal = 0;

    for (let i = 0; i < instruments.length; i++) {
      const inst = instruments[i];
      console.log(`[${i + 1}/${instruments.length}] ${inst} (${tf})`);

      const count = await backfillInstrument(inst, tf);
      grandTotal += count;

      // Brief pause between instruments to respect rate limits
      await sleep(RATE_MS);
    }

    summary[tf] = grandTotal;
    console.log(`\n✓ ${tf} complete: ${grandTotal.toLocaleString()} total candles stored\n`);
  }

  return summary;
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

async function main() {
  validate();

  const arg = (process.argv[2] || '').toUpperCase();
  let timeframes;

  if (arg === 'H1')       timeframes = ['H1'];
  else if (arg === 'M15') timeframes = ['M15'];
  else if (arg === 'M5')  timeframes = ['M5'];
  else                    timeframes = ['H1', 'M15'];

  console.log(`\nNervaFX Historical Backfill`);
  console.log(`Timeframes: ${timeframes.join(', ')}`);
  console.log(`Range: ${MONTHS} months`);
  console.log(`Instruments: ${config.instruments.length}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const t0 = Date.now();
  const summary = await backfillAll(timeframes);
  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  BACKFILL COMPLETE — ${elapsed} minutes`);
  for (const [tf, count] of Object.entries(summary)) {
    console.log(`  ${tf}: ${count.toLocaleString()} candles`);
  }
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
