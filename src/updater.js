const { config } = require('./config');
const { fetchCandles, fetchAndParseCandles, sleep, RATE_LIMIT_DELAY } = require('./oanda');
const { supabase, upsertCandles } = require('./supabase');
const { runFullQualityCheck } = require('./quality');
const { repairAll } = require('./repair');
const { calculateLatestStrength } = require('./strength');
const { smoothLatest } = require('./smooth');
const { calculateLatestSpreads } = require('./spread');
const { calculateLatestM15Spreads } = require('./m15');
const { calculateLatestStates } = require('./stateDetect');
const { calculateLatestSignals } = require('./signals');
const { checkLatestSignals } = require('./risk');
const { processLatestActions } = require('./actions');
const { calculateLatestSentiment } = require('./riskSentiment');
const { writeJournalEntry } = require('./journalEngine');
const { runOutcomeReviews } = require('./outcomeReview');
const { backfillSessionActivity } = require('./sessionActivity');
const { generateMarketNarrative }        = require('./narrativeEngine');
const { calculateFlowPerformance }       = require('./flowPerformance');
const { calculateLatestVolumeAnalysis }  = require('./volumeAnalysis');
const { calculateEnergyDirection }       = require('./energyDirection');

const PARALLEL = 7; // instruments fetched in parallel (OANDA rate-limit safe)

async function step(name, fn) {
  try {
    await fn();
    console.log(`[UPDATE] ✓ ${name}`);
  } catch (err) {
    console.error(`[UPDATE] ✗ ${name}: ${err.message}`);
  }
}

/**
 * Sync candles for a specific timeframe (H1 or M15) from OANDA → backtest_candles.
 * Fetches incrementally from the last stored candle per instrument.
 */
async function syncCandles(timeframe) {
  let totalSynced = 0;

  for (let i = 0; i < config.instruments.length; i += PARALLEL) {
    const batch = config.instruments.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(batch.map(async (inst) => {
      // Find latest stored candle for this instrument + timeframe
      const { data: latest } = await supabase
        .from('backtest_candles')
        .select('time')
        .eq('instrument', inst)
        .eq('timeframe', timeframe)
        .order('time', { ascending: false })
        .limit(1);

      let fromISO;
      if (latest?.length) {
        const lt = new Date(latest[0].time);
        lt.setSeconds(lt.getSeconds() + 1);
        fromISO = lt.toISOString();
      } else {
        fromISO = new Date(Date.now() - 7 * 86400000).toISOString();
      }
      if (new Date(fromISO) >= new Date()) return 0;

      // Use count-based fetch (no 'to') to avoid "Time is in the future" on practice accounts
      const raw = await fetchCandles(inst, {
        from: fromISO,
        granularity: timeframe,
      });
      const candles = raw.filter(c => c.complete).map(c => ({
        instrument: inst, timeframe, time: c.time,
        open: parseFloat(c.mid.o), high: parseFloat(c.mid.h),
        low: parseFloat(c.mid.l), close: parseFloat(c.mid.c),
        volume: c.volume, complete: true, source: 'OANDA',
      }));
      if (!candles.length) return 0;

      for (let j = 0; j < candles.length; j += 500) {
        const b = candles.slice(j, j + 500);
        const { error } = await supabase
          .from('backtest_candles')
          .upsert(b, { onConflict: 'instrument,timeframe,time', ignoreDuplicates: true });
        if (error) throw new Error(`${inst}/${timeframe}: ${error.message}`);
      }
      return candles.length;
    }));

    for (const r of results) {
      if (r.status === 'fulfilled') totalSynced += (r.value || 0);
      else console.error(`[UPDATE] ${timeframe} sync error: ${r.reason?.message || r.reason}`);
    }
    if (i + PARALLEL < config.instruments.length) await sleep(150);
  }

  return totalSynced;
}

async function hourlyUpdate() {
  console.log(`[UPDATE] ${new Date().toISOString()} - Starting hourly update...`);

  // ── Phase 1: Sync candles (M15 + H1) from OANDA → backtest_candles ─────────
  // M15 is needed for volume analysis, m15_spreads, energy direction, DE history
  // H1 is needed for strength, smooth, spreads, signals
  await step('sync_m15', async () => {
    const n = await syncCandles('M15');
    if (n > 0) console.log(`[UPDATE]   synced ${n} M15 candles`);
  });
  await step('sync_h1', async () => {
    const n = await syncCandles('H1');
    if (n > 0) console.log(`[UPDATE]   synced ${n} H1 candles`);
  });

  // ── Phase 1: Quality check + repair ────────────────────────────────────────
  let check;
  try {
    ({ check } = await runFullQualityCheck());
  } catch (err) {
    console.error(`[UPDATE] Quality check failed: ${err.message}. Continuing with engine anyway.`);
    check = { status: 'CLEAN', found_candles: '?' };
  }

  if (check.status !== 'CLEAN') {
    console.log(`[UPDATE] Gaps found (${check.missing_candles}). Repairing...`);
    const repair = await repairAll();

    if (repair.status !== 'ALL_CLEAN') {
      console.error('[UPDATE] REPAIR FAILED — halting pipeline.');
      return { status: 'FAILED', check };
    }

    try {
      const { check: finalCheck } = await runFullQualityCheck();
      if (finalCheck.status !== 'CLEAN') {
        console.error('[UPDATE] Still dirty after repair — halting.');
        return { status: 'FAILED', check: finalCheck };
      }
      check = finalCheck;
    } catch (err) {
      console.error(`[UPDATE] Post-repair quality check failed: ${err.message}. Continuing.`);
    }
  }

  console.log(`[UPDATE] Data clean (${check.found_candles} candles). Running engine...`);

  // ── Phases 2–8: Each step is isolated — one failure won't kill the rest ────
  await step('strength',      () => calculateLatestStrength());
  await step('smooth',        () => smoothLatest());
  await step('spreads',       () => calculateLatestSpreads());
  await step('m15_spreads',   () => calculateLatestM15Spreads());
  await step('volume_analysis', () => calculateLatestVolumeAnalysis());
  await step('flow_perf',    () => calculateFlowPerformance());
  await step('sentiment',     () => calculateLatestSentiment());
  await step('states',        () => calculateLatestStates());
  await step('signals',       () => calculateLatestSignals());
  await step('risk',          () => checkLatestSignals());
  await step('actions',       () => processLatestActions());
  await step('session_activity',    () => backfillSessionActivity());
  await step('energy_direction',   () => calculateEnergyDirection());
  await step('market_narrative',    () => generateMarketNarrative());
  await step('journal',             () => writeJournalEntry());
  await step('outcomes',         () => runOutcomeReviews());

  console.log('[UPDATE] Complete.');
  return { status: 'CLEAN', check };
}

async function runAnalysis() {
  console.log(`[ANALYZE] ${new Date().toISOString()} - Running engine on current data...`);
  await step('strength',  () => calculateLatestStrength());
  await step('smooth',    () => smoothLatest());
  await step('spreads',   () => calculateLatestSpreads());
  await step('sentiment', () => calculateLatestSentiment());
  await step('states',    () => calculateLatestStates());
  await step('signals',  () => calculateLatestSignals());
  await step('risk',     () => checkLatestSignals());
  await step('actions',  () => processLatestActions());
  console.log('[ANALYZE] Complete.');
}

module.exports = { hourlyUpdate, runAnalysis, syncCandles };
