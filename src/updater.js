const { config } = require('./config');
const { fetchAndParseCandles, sleep, RATE_LIMIT_DELAY } = require('./oanda');
const { upsertCandles } = require('./supabase');
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
const { calculateLatestSessionActivity } = require('./sessionActivity');
const { generateMarketNarrative }        = require('./narrativeEngine');

async function step(name, fn) {
  try {
    await fn();
    console.log(`[UPDATE] ✓ ${name}`);
  } catch (err) {
    console.error(`[UPDATE] ✗ ${name}: ${err.message}`);
  }
}

async function hourlyUpdate() {
  console.log(`[UPDATE] ${new Date().toISOString()} - Starting hourly update...`);

  // ── Phase 1: Fetch candles ──────────────────────────────────────────────────
  for (const instrument of config.instruments) {
    try {
      const candles = await fetchAndParseCandles(instrument, { count: 5 });
      if (candles.length > 0) await upsertCandles(candles);
      await sleep(RATE_LIMIT_DELAY);
    } catch (err) {
      console.error(`[UPDATE] ${instrument}: ${err.message}`);
    }
  }

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
  await step('sentiment',     () => calculateLatestSentiment());
  await step('states',        () => calculateLatestStates());
  await step('signals',       () => calculateLatestSignals());
  await step('risk',          () => checkLatestSignals());
  await step('actions',       () => processLatestActions());
  await step('session_activity',    () => calculateLatestSessionActivity());
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

module.exports = { hourlyUpdate, runAnalysis };
