const { config } = require('./config');
const { fetchAndParseCandles, sleep, RATE_LIMIT_DELAY } = require('./oanda');
const { upsertCandles } = require('./supabase');
const { runFullQualityCheck } = require('./quality');
const { repairAll } = require('./repair');
const { calculateLatestStrength } = require('./strength');
const { smoothLatest } = require('./smooth');
const { calculateLatestSpreads } = require('./spread');
const { calculateLatestStates } = require('./stateDetect');
const { calculateLatestSignals } = require('./signals');
const { checkLatestSignals } = require('./risk');
const { processLatestActions } = require('./actions');

async function hourlyUpdate() {
  console.log(`[UPDATE] ${new Date().toISOString()} - Starting hourly update...`);

  for (const instrument of config.instruments) {
    try {
      const candles = await fetchAndParseCandles(instrument, { count: 5 });

      if (candles.length > 0) {
        await upsertCandles(candles);
        console.log(`[UPDATE] ${instrument}: upserted ${candles.length} candles`);
      }

      await sleep(RATE_LIMIT_DELAY);
    } catch (err) {
      console.error(`[UPDATE] ${instrument}: FAILED - ${err.message}`);
    }
  }

  console.log('[UPDATE] Fetch complete. Running quality check...');
  const { check } = await runFullQualityCheck();

  if (check.status !== 'CLEAN') {
    console.log(`[UPDATE] Gaps found (${check.missing_candles} missing). Running repair...`);
    const repair = await repairAll();

    if (repair.status !== 'ALL_CLEAN') {
      console.error('[UPDATE] REPAIR FAILED. System should not proceed to strength calculation.');
      return { status: 'FAILED', check, repair };
    }

    console.log('[UPDATE] Repair successful. Running final quality check...');
    const { check: finalCheck } = await runFullQualityCheck();

    if (finalCheck.status !== 'CLEAN') {
      console.error('[UPDATE] STILL DIRTY after repair. Halting.');
      return { status: 'FAILED', check: finalCheck };
    }
  }

  console.log('[UPDATE] Data is clean. Calculating currency strength...');
  try {
    const strength = await calculateLatestStrength();
    console.log(`[UPDATE] Strength stored for ${strength.time}`);
    await smoothLatest();
    await calculateLatestSpreads();
    await calculateLatestStates();
    await calculateLatestSignals();
    await checkLatestSignals();
    await processLatestActions();
    return { status: 'CLEAN', check, strength: strength.time };
  } catch (err) {
    console.error(`[UPDATE] Strength/smooth failed: ${err.message}`);
    return { status: 'STRENGTH_FAILED', check, error: err.message };
  }
}

module.exports = { hourlyUpdate };
