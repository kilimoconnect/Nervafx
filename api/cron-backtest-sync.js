'use strict';

/**
 * GET /api/cron-backtest-sync
 *
 * Incremental sync of backtest_candles table.
 * For each instrument × timeframe, finds the latest stored candle and fetches
 * everything from OANDA since then.
 *
 * Runs every hour via Vercel Cron.
 *
 * Optimised:
 *   - M15 first (needed for DE), then H1
 *   - Parallel batches of 7 instruments (stays within OANDA rate limits)
 *   - Skips weekends (market closed)
 *   - 300s Vercel timeout with progress tracking
 *
 * Auth: Vercel Cron header or CRON_SECRET bearer token.
 */

const { createClient } = require('@supabase/supabase-js');
const { fetchCandles, sleep } = require('../src/oanda');

// ── Config ──────────────────────────────────────────────────────────────────

const INSTRUMENTS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CAD_JPY','CAD_CHF','CHF_JPY',
];

// Fetch order: M5 → M15 → H1. M5 added so the currency-strength-m5-ema
// engines have a live series; the pipeline's DE computation still only
// depends on M15 + H1 so the added timeframe is passive downstream.
const TIMEFRAMES    = ['M5', 'M15', 'H1'];
const BATCH_SIZE    = 500;   // DB upsert batch
const PARALLEL      = 7;     // instruments fetched in parallel per batch
const RATE_MS       = 150;   // delay between OANDA calls within a parallel batch
const FALLBACK_DAYS = 7;     // if no data found, fetch last 7 days (was 3 — wider safety net)
const DEADLINE_MS   = 270000; // 270s — stop before 300s Vercel timeout

// ── Auth ────────────────────────────────────────────────────────────────────

function verifyCron(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  return !!(process.env.CRON_SECRET && auth === process.env.CRON_SECRET);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function isMarketOpen() {
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  // Forex market: Sun 21:00 UTC → Fri 21:00 UTC
  if (day === 6) return false;                    // all Saturday
  if (day === 0 && hour < 21) return false;       // Sunday before 21:00
  if (day === 5 && hour >= 21) return false;      // Friday after 21:00
  return true;
}

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

async function upsertBatched(sb, candles) {
  let total = 0;
  for (let i = 0; i < candles.length; i += BATCH_SIZE) {
    const batch = candles.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from('backtest_candles')
      .upsert(batch, { onConflict: 'instrument,timeframe,time', ignoreDuplicates: true });
    if (error) throw new Error(`Upsert error: ${error.message}`);
    total += batch.length;
  }
  return total;
}

// ── Core sync ───────────────────────────────────────────────────────────────

async function syncInstrument(sb, instrument, timeframe) {
  // Find the latest stored candle time for this instrument+timeframe
  const { data: latest, error: qErr } = await sb
    .from('backtest_candles')
    .select('time')
    .eq('instrument', instrument)
    .eq('timeframe', timeframe)
    .order('time', { ascending: false })
    .limit(1);

  if (qErr) throw new Error(`Query error for ${instrument}/${timeframe}: ${qErr.message}`);

  let fromISO;
  if (latest && latest.length > 0) {
    const lastTime = new Date(latest[0].time);
    lastTime.setSeconds(lastTime.getSeconds() + 1);
    fromISO = lastTime.toISOString();
  } else {
    const fallback = new Date();
    fallback.setUTCDate(fallback.getUTCDate() - FALLBACK_DAYS);
    fromISO = fallback.toISOString();
  }

  if (new Date(fromISO) >= new Date()) return 0;

  const raw = await fetchCandles(instrument, {
    from: fromISO,
    granularity: timeframe,
  });

  const candles = parseRawCandles(instrument, raw, timeframe);
  if (candles.length === 0) return 0;

  return upsertBatched(sb, candles);
}

// ── Handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!verifyCron(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Skip weekends — no new candles to fetch
  if (!isMarketOpen()) {
    console.log('[BT-SYNC] Market closed — skipping');
    return res.json({ ok: true, skipped: true, reason: 'market closed' });
  }

  const t0 = Date.now();
  const sb = getDB();
  const log = [];
  let totalCandles = 0;
  let errors = 0;

  for (const tf of TIMEFRAMES) {
    // Check deadline before starting next timeframe
    if (Date.now() - t0 > DEADLINE_MS) {
      log.push(`DEADLINE: skipped ${tf} (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
      break;
    }

    // Process instruments in parallel batches
    for (let i = 0; i < INSTRUMENTS.length; i += PARALLEL) {
      // Check deadline before each batch
      if (Date.now() - t0 > DEADLINE_MS) {
        log.push(`DEADLINE: skipped remaining ${tf} instruments (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
        break;
      }

      const batch = INSTRUMENTS.slice(i, i + PARALLEL);
      const results = await Promise.allSettled(
        batch.map(async (inst) => {
          const count = await syncInstrument(sb, inst, tf);
          return { inst, count };
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          const { inst, count } = r.value;
          if (count > 0) {
            log.push(`${inst}/${tf}: +${count}`);
            totalCandles += count;
          }
        } else {
          errors++;
          log.push(`${tf}: ERROR ${r.reason?.message || r.reason}`);
          console.error(`[BT-SYNC] ${tf}:`, r.reason?.message || r.reason);
        }
      }

      // Small delay between batches to respect OANDA rate limits
      if (i + PARALLEL < INSTRUMENTS.length) await sleep(RATE_MS);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[BT-SYNC] Done in ${elapsed}s — ${totalCandles} candles, ${errors} errors`);

  res.json({
    ok: true,
    candles: totalCandles,
    errors,
    elapsed: `${elapsed}s`,
    details: log,
  });
};

module.exports.maxDuration = 300;
