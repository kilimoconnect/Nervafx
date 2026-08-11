'use strict';

/**
 * NervaFX H1 Continuation Engine — historical detector-validation runner (CLI).
 *
 * NOT a trading backtest: prints detector statistics only (no entries/P&L).
 * Uses direct completed H1 candles. Usage:
 *   node scripts/h1c-validate.js [asOfISO] [limitPerPair]
 */

require('dotenv').config();
const { getClient } = require('../api/_db');
const { fetchClosedH1 } = require('../api/_h1c-data');
const { PAIRS } = require('../api/_h1c-constants');
const { runValidation } = require('../api/_h1c-validate');

(async () => {
  const sb = getClient();
  const evalMs = process.argv[2] ? new Date(process.argv[2]).getTime() : Date.now();
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 500;

  const store = {};
  let skipped = 0;
  for (const p of PAIRS) {
    try {
      const d = await fetchClosedH1(sb, p, { evalMs, limit });
      if (d.ok) store[p] = d.candles; else skipped++;
    } catch (e) {
      skipped++;
      console.error(`[h1c-validate] ${p}: ${e.message}`);
    }
  }

  const summary = runValidation(store, {});
  console.log(JSON.stringify({
    asOf: new Date(evalMs).toISOString(),
    timeframe: 'H1',
    pairsLoaded: Object.keys(store).length,
    pairsSkipped: skipped,
    ...summary,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
