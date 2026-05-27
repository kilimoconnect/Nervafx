'use strict';

/**
 * POST /api/run-pipeline
 *
 * Full pipeline: fetches candles from OANDA, then runs analysis + backfill.
 * Runs: candles → strength → smooth → spreads → states → signals → risk →
 *       session_backfill → narrative → journal
 *
 * Protected: requires admin JWT or CRON_SECRET.
 *
 * Usage:  POST /api/run-pipeline?force=1   (with Bearer token header)
 */

const { createClient } = require('@supabase/supabase-js');
const { fetchCandles, sleep }            = require('../src/oanda');
const { config }                         = require('../src/config');
const { calculateLatestStates }          = require('../src/stateDetect');
const { calculateLatestSignals }         = require('../src/signals');
const { checkLatestSignals }             = require('../src/risk');
const { calculateLatestM15Spreads }      = require('../src/m15');
const { calculateLatestSentiment }       = require('../src/riskSentiment');
const { processLatestActions }           = require('../src/actions');
const { backfillSessionActivity }        = require('../src/sessionActivity');
const { generateMarketNarrative }        = require('../src/narrativeEngine');
const { writeJournalEntry }              = require('../src/journalEngine');
const { runOutcomeReviews }              = require('../src/outcomeReview');
const { sendSignalAlerts }              = require('../src/emailAlerts');
const { calculateLatestVolumeAnalysis } = require('../src/volumeAnalysis');
const { calculateFlowPerformance }     = require('../src/flowPerformance');
const { calculateEnergyDirection }     = require('../src/energyDirection');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const INSTRUMENTS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD',
  'CAD_JPY','CAD_CHF','CHF_JPY',
];
const LOOKBACKS = [3, 6, 12];
const PAIRS_PER_CURRENCY = 7;

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function verifyAdmin(sb, req) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return false;
  // Accept Vercel Cron secret (no Supabase round-trip needed)
  if (process.env.CRON_SECRET && auth === process.env.CRON_SECRET) return true;
  const { data: { user } } = await sb.auth.getUser(auth);
  return user?.id === ADMIN_ID;
}

// ── Strength ──────────────────────────────────────────────────────────────────
// Uses positional (candle-count) lookbacks instead of calendar-hour arithmetic.
// This means "3H" = 3 completed H1 candles back, not "now - 3 hours".
// Weekend gaps are invisible — there are simply no candles then, so the 12th
// candle back from Monday morning lands on Friday, not a dead Saturday slot.

async function runStrength(sb) {
  const MIN_CANDLES = 13; // current (0) + max lookback (12) = 13 minimum
  const FETCH       = 20; // a little extra headroom

  // Fetch last FETCH complete H1 candles per instrument, newest first
  const arrays = {};
  for (const inst of INSTRUMENTS) {
    const { data, error } = await sb
      .from('backtest_candles')
      .select('time, close')
      .eq('instrument', inst)
      .eq('timeframe', 'H1')
      .eq('complete', true)
      .order('time', { ascending: false })
      .limit(FETCH);
    if (error) throw new Error(`candle fetch ${inst}: ${error.message}`);
    if (!data || data.length < MIN_CANDLES)
      throw new Error(`Not enough candles for ${inst}: need ${MIN_CANDLES}, got ${data?.length ?? 0}`);
    arrays[inst] = data.map(c => ({ time: new Date(c.time).toISOString(), close: parseFloat(c.close) }));
  }

  // Reference time = the oldest "most recent candle" across all instruments
  // (guards against one instrument being one candle ahead of the rest)
  const refTime = INSTRUMENTS.map(inst => arrays[inst][0].time).sort()[0];

  // Compute raw strength using positional offsets — no timestamp arithmetic
  const raw = {
    3:  Object.fromEntries(CURRENCIES.map(c => [c, 0])),
    6:  Object.fromEntries(CURRENCIES.map(c => [c, 0])),
    12: Object.fromEntries(CURRENCIES.map(c => [c, 0])),
  };

  for (const inst of INSTRUMENTS) {
    const arr = arrays[inst];
    const [base, quote] = inst.split('_');

    // Starting index: first candle at or before refTime (normally 0, may be 1 if inst is 1 ahead)
    const refIdx = arr.findIndex(c => c.time <= refTime);
    if (refIdx === -1) throw new Error(`${inst}: no candle at or before ${refTime}`);

    const closeNow = arr[refIdx].close;
    for (const lb of LOOKBACKS) {
      const pastIdx = refIdx + lb;
      if (pastIdx >= arr.length)
        throw new Error(`${inst}: not enough candles for ${lb}-candle lookback`);
      const mv = (closeNow - arr[pastIdx].close) / arr[pastIdx].close;
      raw[lb][base]  += mv;
      raw[lb][quote] -= mv;
    }
  }

  const rows = CURRENCIES.map(currency => ({
    time:           refTime,
    currency,
    raw_3h:         raw[3][currency],
    raw_6h:         raw[6][currency],
    raw_12h:        raw[12][currency],
    normalized_3h:  raw[3][currency]  / PAIRS_PER_CURRENCY,
    normalized_6h:  raw[6][currency]  / PAIRS_PER_CURRENCY,
    normalized_12h: raw[12][currency] / PAIRS_PER_CURRENCY,
  }));

  const { error: upsErr } = await sb
    .from('currency_strength')
    .upsert(rows, { onConflict: 'time,currency', ignoreDuplicates: false });
  if (upsErr) throw new Error(`strength upsert: ${upsErr.message}`);

  return refTime;
}

// ── Smooth ────────────────────────────────────────────────────────────────────
function ema(prev, cur) {
  if (prev == null) return cur;
  return (prev + cur) / 2;
}

async function runSmooth(sb) {
  const updates = [];
  for (const currency of CURRENCIES) {
    const { data, error } = await sb
      .from('currency_strength')
      .select('id, time, currency, normalized_3h, normalized_6h, normalized_12h')
      .eq('currency', currency)
      .order('time', { ascending: false })
      .limit(2);
    if (error || !data?.length) continue;

    const current  = data[0];
    const previous = data[1] || null;
    let p3 = null, p6 = null, p12 = null;

    if (previous) {
      const { data: pr } = await sb
        .from('currency_strength')
        .select('smooth_3h, smooth_6h, smooth_12h')
        .eq('id', previous.id)
        .single();
      if (pr) { p3 = pr.smooth_3h; p6 = pr.smooth_6h; p12 = pr.smooth_12h; }
    }

    updates.push({
      id: current.id, time: current.time, currency,
      smooth_3h:  ema(p3,  current.normalized_3h),
      smooth_6h:  ema(p6,  current.normalized_6h),
      smooth_12h: ema(p12, current.normalized_12h),
    });
  }
  const { error } = await sb.from('currency_strength').upsert(updates, { onConflict: 'id' });
  if (error) throw new Error(`smooth upsert: ${error.message}`);
}

// ── Spreads ───────────────────────────────────────────────────────────────────
async function runSpreads(sb) {
  // Get latest 8 smooth rows per currency
  const csMap = {};
  for (const currency of CURRENCIES) {
    const { data } = await sb
      .from('currency_strength')
      .select('time, currency, smooth_3h, smooth_6h, smooth_12h')
      .eq('currency', currency)
      .not('smooth_3h', 'is', null)
      .order('time', { ascending: false })
      .limit(8);
    for (const r of data || []) {
      if (!csMap[r.time]) csMap[r.time] = {};
      csMap[r.time][r.currency] = r;
    }
  }

  const latestTime = Object.keys(csMap).sort().pop();
  if (!latestTime) return;

  const snapshot = csMap[latestTime];
  const rows = [];

  for (const inst of INSTRUMENTS) {
    const [base, quote] = inst.split('_');
    const b = snapshot[base], q = snapshot[quote];
    if (!b || !q) continue;

    const s3h  = (parseFloat(b.smooth_3h)  || 0) - (parseFloat(q.smooth_3h)  || 0);
    const s6h  = (parseFloat(b.smooth_6h)  || 0) - (parseFloat(q.smooth_6h)  || 0);
    const s12h = (parseFloat(b.smooth_12h) || 0) - (parseFloat(q.smooth_12h) || 0);
    rows.push({
      time:           latestTime,
      instrument:     inst,
      base_currency:  base,
      quote_currency: quote,
      spread_3h:      s3h,
      spread_6h:      s6h,
      spread_12h:     s12h,
      // weighted_score and bias are computed at read time in api/spreads.js, not stored
    });
  }

  rows.sort((a, b) => Math.abs(b.weighted_score) - Math.abs(a.weighted_score));
  const { error } = await sb
    .from('pair_strength_spreads')
    .upsert(rows, { onConflict: 'time,instrument', ignoreDuplicates: false });
  if (error) throw new Error(`spreads upsert: ${error.message}`);
}

function isMarketOpen() {
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 21) return false;
  if (day === 5 && hour >= 21) return false;
  return true;
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST/GET only' });

  const sb = getDB();

  try {
    const isAdmin = await verifyAdmin(sb, req);
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
  } catch (_) {
    return res.status(403).json({ error: 'Auth error' });
  }

  const force = req.query?.force === '1' || req.query?.force === 'true';
  if (!isMarketOpen() && !force) {
    return res.json({ ok: true, skipped: true, reason: 'market closed' });
  }

  const log = [];
  const step = async (name, fn) => {
    try {
      await fn();
      log.push(`✓ ${name}`);
    } catch (e) {
      log.push(`✗ ${name}: ${e.message}`);
    }
  };

  const t0 = Date.now();
  let strengthTime = null;

  // ── Candle freshness guard ───────────────────────────────────────────────
  // If cron-backtest-sync missed a run or was slow, the pipeline self-heals
  // by syncing stale instruments inline before proceeding.
  await step('candle_sync', async () => {
    // M15: ALWAYS sync — DE history depends on backtest_candles M15 being
    // current every hour. Only fetches new candles since last stored time,
    // so it's fast (~5-10s) when cron-backtest-sync already ran at :00.
    // H1: only sync if stale (>2h), since strength.js only needs the latest.
    const STALE_MS_H1  = 2 * 60 * 60 * 1000;  // 2 hours
    const PARALLEL = 7;
    const TFS = ['M15', 'H1'];

    for (const tf of TFS) {
      if (tf === 'H1') {
        // H1: check staleness before syncing
        const { data: newest } = await sb.from('backtest_candles')
          .select('time')
          .eq('timeframe', tf)
          .eq('complete', true)
          .order('time', { ascending: false })
          .limit(1);

        const latestTime = newest?.[0]?.time ? new Date(newest[0].time).getTime() : 0;
        const age = Date.now() - latestTime;

        if (age <= STALE_MS_H1) continue; // H1 fresh enough
      }
      console.log(`[PIPELINE] Syncing ${tf} candles...`);

      // Sync all instruments for this timeframe in parallel batches
      let synced = 0;
      for (let i = 0; i < INSTRUMENTS.length; i += PARALLEL) {
        const batch = INSTRUMENTS.slice(i, i + PARALLEL);
        const results = await Promise.allSettled(batch.map(async (inst) => {
          const { data: latest } = await sb.from('backtest_candles')
            .select('time').eq('instrument', inst).eq('timeframe', tf)
            .order('time', { ascending: false }).limit(1);

          let fromISO;
          if (latest?.length) {
            const lt = new Date(latest[0].time);
            lt.setSeconds(lt.getSeconds() + 1);
            fromISO = lt.toISOString();
          } else {
            fromISO = new Date(Date.now() - 7 * 86400000).toISOString();
          }
          if (new Date(fromISO) >= new Date()) return 0;

          const raw = await fetchCandles(inst, { from: fromISO, granularity: tf });
          const candles = raw.filter(c => c.complete).map(c => ({
            instrument: inst, timeframe: tf, time: c.time,
            open: parseFloat(c.mid.o), high: parseFloat(c.mid.h),
            low: parseFloat(c.mid.l), close: parseFloat(c.mid.c),
            volume: c.volume, complete: true, source: 'OANDA',
          }));
          if (!candles.length) return 0;
          for (let j = 0; j < candles.length; j += 500) {
            const b = candles.slice(j, j + 500);
            const { error } = await sb.from('backtest_candles')
              .upsert(b, { onConflict: 'instrument,timeframe,time', ignoreDuplicates: true });
            if (error) throw new Error(`${inst}: ${error.message}`);
          }
          return candles.length;
        }));
        for (const r of results) {
          if (r.status === 'fulfilled') synced += (r.value || 0);
        }
        if (i + PARALLEL < INSTRUMENTS.length) await sleep(150);
      }
      if (synced > 0) console.log(`[PIPELINE] Synced ${synced} ${tf} candles inline`);
    }
  });

  await step('strength', async () => { strengthTime = await runStrength(sb); });
  await step('smooth',   () => runSmooth(sb));
  await step('spreads',  () => runSpreads(sb));
  await step('m15_spreads',      () => calculateLatestM15Spreads());
  await step('volume_analysis',  () => calculateLatestVolumeAnalysis());
  await step('sentiment',        () => calculateLatestSentiment());
  await step('states',           () => calculateLatestStates());
  await step('signals',          () => calculateLatestSignals());
  await step('risk',             () => checkLatestSignals());
  await step('actions',          () => processLatestActions());
  await step('session_backfill', () => backfillSessionActivity());
  await step('energy_direction', () => calculateEnergyDirection());
  await step('flow_performance', () => calculateFlowPerformance());
  await step('market_narrative', () => generateMarketNarrative());
  await step('journal',          () => writeJournalEntry());
  await step('outcomes',         () => runOutcomeReviews());
  await step('email_alerts',     () => sendSignalAlerts(sb));

  return res.json({
    ok:           true,
    strength_time: strengthTime,
    elapsed_ms:   Date.now() - t0,
    steps:        log,
  });
};
