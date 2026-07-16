'use strict';

/**
 * GET /api/backfill-m5?from=YYYY-MM-DD[&to=YYYY-MM-DD][&pair=EUR_USD]
 *   Requires header Authorization: Bearer $CRON_SECRET (or the ?secret= query).
 *
 * Fills historical M5 candles for the 28 majors between `from` and `to`.
 *   - Default `to` is the earliest M5 candle currently in the DB (i.e. we
 *     fill BACKWARD from where the sync started).
 *   - Default `pair` is all 28 pairs.
 *
 * OANDA can return up to 5000 candles per request, so we chunk each pair in
 * 15-day windows (~4320 M5 candles). Pairs run 7 at a time in parallel with
 * a 250 ms rate-limit gap between chunks; the handler bails out cleanly at
 * ~270 s so Vercel doesn't kill it mid-write.
 *
 * If the deadline hits before we finish, the response reports
 * `remaining_pairs` and the last `filled_up_to` per pair so the caller can
 * re-invoke with a narrower window if needed.
 */

const { createClient } = require('@supabase/supabase-js');
const { fetchCandles } = require('../src/oanda');

const PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

const CHUNK_DAYS  = 15;                     // ~4320 M5 candles per chunk
const CHUNK_MS    = CHUNK_DAYS * 24 * 3600 * 1000;
const RATE_MS     = 250;
const PARALLEL    = 7;
const BATCH_SIZE  = 500;
const DEADLINE_MS = 270000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function verifyAuth(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  const secret = req.query?.secret || '';
  const expect = process.env.CRON_SECRET;
  return !!(expect && (bearer === expect || secret === expect));
}

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function earliestM5(sb, inst) {
  const { data, error } = await sb
    .from('backtest_candles')
    .select('time')
    .eq('instrument', inst).eq('timeframe', 'M5')
    .order('time', { ascending: true }).limit(1);
  if (error) throw new Error(`earliest ${inst}: ${error.message}`);
  return data && data[0] ? new Date(data[0].time) : null;
}

function parseRaw(inst, raw) {
  return raw
    .filter(c => c.complete === true)
    .map(c => ({
      instrument: inst,
      timeframe:  'M5',
      time:       c.time,
      open:   parseFloat(c.mid.o),
      high:   parseFloat(c.mid.h),
      low:    parseFloat(c.mid.l),
      close:  parseFloat(c.mid.c),
      volume: c.volume,
      complete: true,
      source:  'OANDA-BACKFILL',
    }));
}

async function upsertBatched(sb, candles) {
  let total = 0;
  for (let i = 0; i < candles.length; i += BATCH_SIZE) {
    const batch = candles.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from('backtest_candles')
      .upsert(batch, { onConflict: 'instrument,timeframe,time', ignoreDuplicates: true });
    if (error) throw new Error(`upsert: ${error.message}`);
    total += batch.length;
  }
  return total;
}

// Fill one pair by walking chunks from `from` forward until `to`.
async function fillPair(sb, inst, fromMs, toMs, t0) {
  let cursor = fromMs;
  let filled = 0;
  let chunks = 0;
  while (cursor < toMs) {
    if (Date.now() - t0 > DEADLINE_MS) return { filled, chunks, filled_up_to: new Date(cursor).toISOString(), timeout: true };
    const chunkEnd = Math.min(cursor + CHUNK_MS, toMs);
    try {
      const raw = await fetchCandles(inst, {
        from: new Date(cursor).toISOString(),
        to:   new Date(chunkEnd).toISOString(),
        granularity: 'M5',
      });
      const parsed = parseRaw(inst, raw);
      if (parsed.length) filled += await upsertBatched(sb, parsed);
    } catch (e) {
      // Continue past a bad chunk — mark and move on. Common cause: gap in
      // OANDA's data on weekends or pair-specific holidays.
      console.warn(`[backfill-m5] ${inst} ${new Date(cursor).toISOString()}: ${e.message}`);
    }
    chunks++;
    cursor = chunkEnd;
    await sleep(RATE_MS);
  }
  return { filled, chunks, filled_up_to: new Date(cursor).toISOString(), timeout: false };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!verifyAuth(req)) return res.status(401).json({ error: 'Unauthorized — supply CRON_SECRET' });

  const fromDate = req.query?.from;
  const toDate   = req.query?.to;
  const onlyPair = req.query?.pair;
  if (!fromDate) return res.status(400).json({ error: 'from=YYYY-MM-DD is required' });

  const fromMs = new Date(fromDate + 'T00:00:00Z').getTime();
  if (isNaN(fromMs)) return res.status(400).json({ error: 'bad from date' });

  const t0 = Date.now();
  const sb = getDB();
  const pairs = onlyPair ? [onlyPair] : PAIRS;
  const report = {};
  let anyTimeout = false;

  for (let i = 0; i < pairs.length; i += PARALLEL) {
    if (Date.now() - t0 > DEADLINE_MS) {
      report._deadline_hit_after = pairs.slice(0, i);
      report._remaining_pairs = pairs.slice(i);
      break;
    }
    const batch = pairs.slice(i, i + PARALLEL);
    await Promise.all(batch.map(async inst => {
      // Determine this pair's fill target: user's `to`, else the earliest
      // M5 candle already in the DB (fill backward from the sync's start).
      let toMs;
      if (toDate) {
        toMs = new Date(toDate + 'T23:55:00Z').getTime();
      } else {
        const earliest = await earliestM5(sb, inst);
        toMs = earliest ? earliest.getTime() : Date.now();
      }
      if (toMs <= fromMs) {
        report[inst] = { skipped: true, reason: 'to <= from' };
        return;
      }
      const r = await fillPair(sb, inst, fromMs, toMs, t0);
      if (r.timeout) anyTimeout = true;
      report[inst] = r;
    }));
  }

  res.json({
    ok: true,
    from: new Date(fromMs).toISOString(),
    duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    any_timeout: anyTimeout,
    report,
  });
};

module.exports.maxDuration = 300;
