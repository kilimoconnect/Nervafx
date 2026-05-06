const { getCandlesForInstrument, insertQualityCheck } = require('./supabase');
const { config } = require('./config');

function generateExpectedTimestamps(oldest, latest) {
  const expected = [];
  const current = new Date(oldest);
  const end = new Date(latest);

  while (current <= end) {
    const day = current.getUTCDay();
    const hour = current.getUTCHours();

    // Forex market hours: Sunday 21:00 UTC to Friday 21:00 UTC
    // Skip Saturday entirely, skip Sunday before 21:00, skip Friday after 21:00
    const isTradingHour =
      (day >= 1 && day <= 4) || // Mon-Thu: all hours
      (day === 0 && hour >= 21) || // Sunday from 21:00
      (day === 5 && hour < 21); // Friday until 20:00 (21:00 is market close, no candle)

    if (isTradingHour) {
      expected.push(current.toISOString());
    }

    current.setUTCHours(current.getUTCHours() + 1);
  }

  return expected;
}

async function checkMissingCandles(instrument) {
  const candles = await getCandlesForInstrument(instrument, config.granularity);

  if (candles.length === 0) {
    return { instrument, expected: 0, found: 0, missing: [], status: 'NO_DATA' };
  }

  const times = candles.map(c => new Date(c.time).toISOString());
  const timeSet = new Set(times);

  const oldest = times[0];
  const latest = times[times.length - 1];

  const expected = generateExpectedTimestamps(oldest, latest);
  const missing = expected.filter(t => !timeSet.has(t));

  const status = missing.length === 0 ? 'CLEAN' : 'GAPS_FOUND';

  return {
    instrument,
    expected: expected.length,
    found: candles.length,
    missing,
    status,
  };
}

async function runFullQualityCheck() {
  const results = [];
  let totalExpected = 0;
  let totalFound = 0;
  let totalMissing = 0;

  for (const instrument of config.instruments) {
    const result = await checkMissingCandles(instrument);
    results.push(result);
    totalExpected += result.expected;
    totalFound += result.found;
    totalMissing += result.missing.length;
  }

  const overallStatus = totalMissing === 0 ? 'CLEAN' : 'GAPS_FOUND';

  const check = {
    timeframe: config.granularity,
    expected_candles: totalExpected,
    found_candles: totalFound,
    missing_candles: totalMissing,
    status: overallStatus,
    details: {
      instruments: results.map(r => ({
        instrument: r.instrument,
        expected: r.expected,
        found: r.found,
        missing_count: r.missing.length,
        status: r.status,
      })),
    },
  };

  await insertQualityCheck(check);
  return { check, results };
}

module.exports = { checkMissingCandles, runFullQualityCheck, generateExpectedTimestamps };
