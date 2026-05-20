'use strict';

/**
 * GET /api/cron-backtest-sync
 *
 * Incremental sync of backtest_candles table.
 * For each instrument × timeframe, finds the latest stored candle and fetches
 * everything from OANDA since then. Runs every 6 hours via Vercel Cron.
 *
 * Auth: Vercel Cron header or CRON_SECRET bearer token.
 * Vercel timeout: 120s (default function limit).
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

const TIMEFRAMES    = ['H1', 'M15'];
const BATCH_SIZE    = 500;
const RATE_MS       = 250;
const FALLBACK_DAYS = 3; // if no data found, fetch last 3 days

// ── Auth ────────────────────────────────────────────────────────────────────

function verifyCron(req) {
  // Vercel Cron sets this header automatically
  if (req.headers['x-vercel-cron'] === '1') return true;
  // Fallback: CRON_SECRET bearer
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  return !!(process.env.CRON_SECRET && auth === process.env.CRON_SECRET);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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
    // Start 1 second after the last stored candle to avoid re-fetching it
    const lastTime = new Date(latest[0].time);
    lastTime.setSeconds(lastTime.getSeconds() + 1);
    fromISO = lastTime.toISOString();
  } else {
    // No data at all — fetch last FALLBACK_DAYS
    const fallback = new Date();
    fallback.setUTCDate(fallback.getUTCDate() - FALLBACK_DAYS);
    fromISO = fallback.toISOString();
  }

  const toISO = new Date().toISOString();

  // Skip if from is basically now (nothing new to fetch)
  if (new Date(fromISO) >= new Date(toISO)) return 0;

  const raw = await fetchCandles(instrument, {
    from: fromISO,
    to: toISO,
    granularity: timeframe,
  });
  await sleep(RATE_MS);

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

  const t0 = Date.now();
  const sb = getDB();
  const log = [];
  let totalCandles = 0;
  let errors = 0;

  for (const tf of TIMEFRAMES) {
    for (const inst of INSTRUMENTS) {
      try {
        const count = await syncInstrument(sb, inst, tf);
        if (count > 0) {
          log.push(`${inst}/${tf}: +${count}`);
          totalCandles += count;
        }
      } catch (err) {
        errors++;
        log.push(`${inst}/${tf}: ERROR ${err.message}`);
        console.error(`[BT-SYNC] ${inst}/${tf}:`, err.message);
      }
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
