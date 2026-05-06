const { fetchAndParseCandles, sleep, RATE_LIMIT_DELAY } = require('./oanda');
const { upsertCandles } = require('./supabase');
const { checkMissingCandles } = require('./quality');

async function repairInstrument(instrument) {
  const check = await checkMissingCandles(instrument);

  if (check.missing.length === 0) {
    return { instrument, repaired: 0, status: 'ALREADY_CLEAN' };
  }

  console.log(`[REPAIR] ${instrument}: ${check.missing.length} missing candles, fetching...`);

  const missing = check.missing.sort();
  const from = missing[0];
  const to = missing[missing.length - 1];

  const candles = await fetchAndParseCandles(instrument, { from, to });
  await sleep(RATE_LIMIT_DELAY);

  if (candles.length > 0) {
    await upsertCandles(candles);
  }

  const recheck = await checkMissingCandles(instrument);

  if (recheck.missing.length > 0) {
    console.error(`[REPAIR] ${instrument}: still ${recheck.missing.length} missing after repair`);
    return {
      instrument,
      repaired: check.missing.length - recheck.missing.length,
      remaining: recheck.missing.length,
      status: 'INCOMPLETE',
    };
  }

  console.log(`[REPAIR] ${instrument}: fully repaired`);
  return { instrument, repaired: check.missing.length, status: 'REPAIRED' };
}

async function repairAll() {
  const results = [];

  for (const instrument of require('./config').config.instruments) {
    const result = await repairInstrument(instrument);
    results.push(result);
    await sleep(RATE_LIMIT_DELAY);
  }

  const incomplete = results.filter(r => r.status === 'INCOMPLETE');
  if (incomplete.length > 0) {
    console.error(`[REPAIR] ${incomplete.length} instruments still have gaps. HALTING.`);
    return { results, status: 'FAILED', incomplete };
  }

  console.log('[REPAIR] All instruments clean.');
  return { results, status: 'ALL_CLEAN' };
}

module.exports = { repairInstrument, repairAll };
