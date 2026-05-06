const { config } = require('./config');
const { fetchAndParseCandles, sleep, RATE_LIMIT_DELAY } = require('./oanda');
const { upsertCandles } = require('./supabase');

async function initialLoad() {
  console.log(`[LOADER] Starting initial load for ${config.instruments.length} instruments...`);

  const summary = [];

  for (const instrument of config.instruments) {
    try {
      const candles = await fetchAndParseCandles(instrument, { count: config.initialCount });
      console.log(`[LOADER] ${instrument}: fetched ${candles.length} complete candles`);

      if (candles.length > 0) {
        const result = await upsertCandles(candles);
        summary.push({ instrument, candles: candles.length, status: 'OK' });
      } else {
        summary.push({ instrument, candles: 0, status: 'NO_COMPLETE_CANDLES' });
      }

      await sleep(RATE_LIMIT_DELAY);
    } catch (err) {
      console.error(`[LOADER] ${instrument}: FAILED - ${err.message}`);
      summary.push({ instrument, candles: 0, status: 'ERROR', error: err.message });
    }
  }

  const ok = summary.filter(s => s.status === 'OK').length;
  const failed = summary.filter(s => s.status === 'ERROR').length;
  console.log(`[LOADER] Done. ${ok} OK, ${failed} failed out of ${config.instruments.length}`);

  return summary;
}

module.exports = { initialLoad };
