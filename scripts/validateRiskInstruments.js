/**
 * Quick validation — confirms each risk sentiment instrument is reachable
 * on your OANDA account and returns the latest candle close price.
 *
 * Run: node scripts/validateRiskInstruments.js
 */
require('dotenv').config();
const { fetchAndParseCandles } = require('../src/oanda');

const INSTRUMENTS = [
  { name: 'SPX500_USD', label: 'S&P 500 Index' },
  { name: 'NAS100_USD', label: 'NASDAQ 100 Index' },
  { name: 'XAU_USD',    label: 'Gold Spot' },
  { name: 'XAG_USD',    label: 'Silver Spot' },
  { name: 'BCO_USD',    label: 'Brent Crude Oil' },
];

async function main() {
  console.log('\n── Risk Sentiment Instrument Check ──────────────────────');
  console.log(`  API: ${process.env.OANDA_BASE_URL || 'https://api-fxpractice.oanda.com'}`);
  console.log('─'.repeat(56));

  let allOk = true;

  for (const { name, label } of INSTRUMENTS) {
    try {
      const candles = await fetchAndParseCandles(name, { count: 13 });
      if (candles.length === 0) {
        console.log(`  ⚠  ${name.padEnd(14)} ${label} — 0 candles returned (market may be closed)`);
      } else {
        const last = candles[candles.length - 1];
        console.log(`  ✓  ${name.padEnd(14)} ${label} — latest close: ${last.close}  (${candles.length} candles)`);
      }
    } catch (err) {
      console.log(`  ✗  ${name.padEnd(14)} ${label} — FAILED: ${err.message}`);
      allOk = false;
    }
  }

  console.log('─'.repeat(56));
  console.log(allOk ? '  All instruments reachable ✓\n' : '  One or more instruments failed ✗\n');
  process.exit(allOk ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
