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
const { checkLatestSignals }             = require('../src/risk');
const { calculateLatestM15Spreads }      = require('../src/m15');
const { calculateLatestSentiment }       = require('../src/riskSentiment');
const { processLatestActions }           = require('../src/actions');
const { backfillSessionActivity }        = require('../src/sessionActivity');
const { generateMarketNarrative }        = require('../src/narrativeEngine');
const { writeJournalEntry }              = require('../src/journalEngine');
const { runOutcomeReviews }              = require('../src/outcomeReview');
const { calculateLatestVolumeAnalysis } = require('../src/volumeAnalysis');
const { calculateFlowPerformance }     = require('../src/flowPerformance');
const { evaluateAutoTrader }           = require('./autotrader-evaluate');
const { sendQualityAlerts }            = require('../src/qualityAlerts');
const { storeStructureSnapshots }      = require('../src/structureSnapshot');

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
const LOOKBACKS = [3, 4, 6, 12, 24];
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
  const MAX_LB = Math.max(...LOOKBACKS);
  const FETCH  = MAX_LB + 26;
  const MIN_CANDLES = MAX_LB + 1;

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

  let common = new Set(arrays[INSTRUMENTS[0]].map(c => c.time));
  for (let i = 1; i < INSTRUMENTS.length; i++) {
    const s = new Set(arrays[INSTRUMENTS[i]].map(c => c.time));
    common = new Set([...common].filter(t => s.has(t)));
  }
  const commonTimes = [...common].sort();
  if (!commonTimes.length) throw new Error('No common candle timestamps');

  const { data: existing } = await sb
    .from('currency_strength')
    .select('time')
    .in('time', commonTimes)
    .eq('currency', 'USD');
  const filled = new Set((existing || []).map(r => new Date(r.time).toISOString()));

  const latest = commonTimes[commonTimes.length - 1];
  const toCalc = commonTimes.filter(t => !filled.has(t) || t === latest);

  const allRows = [];
  let gapsFilled = 0;

  for (const refTime of toCalc) {
    const raw = {};
    for (const lb of LOOKBACKS) raw[lb] = Object.fromEntries(CURRENCIES.map(c => [c, 0]));

    let ok = true;
    for (const inst of INSTRUMENTS) {
      const arr = arrays[inst];
      const [base, quote] = inst.split('_');
      const refIdx = arr.findIndex(c => c.time <= refTime);
      if (refIdx === -1) { ok = false; break; }
      const closeNow = arr[refIdx].close;
      for (const lb of LOOKBACKS) {
        if (refIdx + lb >= arr.length) { ok = false; break; }
        const mv = (closeNow - arr[refIdx + lb].close) / arr[refIdx + lb].close;
        raw[lb][base] += mv;
        raw[lb][quote] -= mv;
      }
      if (!ok) break;
    }
    if (!ok) continue;

    for (const currency of CURRENCIES) {
      allRows.push({
        time: refTime, currency,
        raw_3h:  raw[3][currency],  raw_4h:  raw[4][currency],
        raw_6h:  raw[6][currency],  raw_12h: raw[12][currency],
        raw_1d:  raw[24][currency],
        normalized_3h:  raw[3][currency]  / PAIRS_PER_CURRENCY,
        normalized_4h:  raw[4][currency]  / PAIRS_PER_CURRENCY,
        normalized_6h:  raw[6][currency]  / PAIRS_PER_CURRENCY,
        normalized_12h: raw[12][currency] / PAIRS_PER_CURRENCY,
        normalized_1d:  raw[24][currency] / PAIRS_PER_CURRENCY,
        smooth_3h: null, smooth_4h: null, smooth_6h: null,
        smooth_12h: null, smooth_1d: null,
      });
    }
    if (!filled.has(refTime)) gapsFilled++;
  }

  for (let i = 0; i < allRows.length; i += 500) {
    const { error } = await sb.from('currency_strength')
      .upsert(allRows.slice(i, i + 500), { onConflict: 'time,currency', ignoreDuplicates: false });
    if (error) throw new Error(`strength upsert: ${error.message}`);
  }

  if (gapsFilled > 0) console.log(`[PIPELINE] Backfilled ${gapsFilled} missing strength hours`);
  return latest;
}

// ── Smooth ────────────────────────────────────────────────────────────────────
function ema(prev, cur) {
  if (prev == null) return cur;
  return (prev + cur) / 2;
}

async function runSmooth(sb) {
  const allUpdates = [];
  for (const currency of CURRENCIES) {
    const { data: unsmoothed, error } = await sb
      .from('currency_strength')
      .select('id, time, normalized_3h, normalized_4h, normalized_6h, normalized_12h, normalized_1d')
      .eq('currency', currency)
      .is('smooth_3h', null)
      .order('time', { ascending: true })
      .limit(50);
    if (error || !unsmoothed?.length) continue;

    const { data: prev } = await sb
      .from('currency_strength')
      .select('smooth_3h, smooth_4h, smooth_6h, smooth_12h, smooth_1d')
      .eq('currency', currency)
      .lt('time', unsmoothed[0].time)
      .not('smooth_3h', 'is', null)
      .order('time', { ascending: false })
      .limit(1);

    let p3 = prev?.[0]?.smooth_3h ?? null;
    let p4 = prev?.[0]?.smooth_4h ?? null;
    let p6 = prev?.[0]?.smooth_6h ?? null;
    let p12 = prev?.[0]?.smooth_12h ?? null;
    let p1d = prev?.[0]?.smooth_1d ?? null;

    for (const row of unsmoothed) {
      p3  = ema(p3,  row.normalized_3h);
      p4  = ema(p4,  parseFloat(row.normalized_4h) || 0);
      p6  = ema(p6,  row.normalized_6h);
      p12 = ema(p12, row.normalized_12h);
      p1d = ema(p1d, parseFloat(row.normalized_1d) || 0);
      allUpdates.push({
        id: row.id, time: row.time, currency,
        smooth_3h: p3, smooth_4h: p4, smooth_6h: p6,
        smooth_12h: p12, smooth_1d: p1d,
      });
    }
  }

  if (!allUpdates.length) return;
  for (let i = 0; i < allUpdates.length; i += 500) {
    const { error } = await sb.from('currency_strength')
      .upsert(allUpdates.slice(i, i + 500), { onConflict: 'id' });
    if (error) throw new Error(`smooth upsert: ${error.message}`);
  }
  if (allUpdates.length > 8)
    console.log(`[PIPELINE] Smoothed ${allUpdates.length / 8} hours (including backfilled)`);
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
  await step('gap_verify', async () => {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const { data } = await sb
      .from('currency_strength')
      .select('time')
      .eq('currency', 'USD')
      .is('smooth_6h', null)
      .gte('time', since);
    if (data?.length) {
      console.warn(`[PIPELINE] ${data.length} unsmoothed rows remain — re-running strength + smooth`);
      await runStrength(sb);
      await runSmooth(sb);
    }
  });
  await step('spreads',  () => runSpreads(sb));
  await step('m15_spreads',      () => calculateLatestM15Spreads());
  await step('volume_analysis',  () => calculateLatestVolumeAnalysis());
  await step('sentiment',        () => calculateLatestSentiment());
  await step('session_backfill', () => backfillSessionActivity());
  await step('quality_alerts',  () => sendQualityAlerts(sb));
  await step('risk',             () => checkLatestSignals());
  await step('actions',          () => processLatestActions());
  await step('flow_performance', () => calculateFlowPerformance());
  await step('market_narrative', () => generateMarketNarrative());
  await step('journal',          () => writeJournalEntry());
  await step('outcomes',         () => runOutcomeReviews());
  await step('structure_engine', () => storeStructureSnapshots(sb));
  await step('autotrader',      () => evaluateAutoTrader(sb));

  return res.json({
    ok:           true,
    strength_time: strengthTime,
    elapsed_ms:   Date.now() - t0,
    steps:        log,
  });
};
