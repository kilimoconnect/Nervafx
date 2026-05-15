const cron = require('node-cron');

// Forex market: opens Sunday 21:00 UTC, closes Friday 21:00 UTC
function isMarketOpen(now = new Date()) {
  const day  = now.getUTCDay();   // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  const hour = now.getUTCHours();
  if (day === 6) return false;                    // Saturday: always closed
  if (day === 0 && hour < 21) return false;       // Sunday before 21:00: closed
  if (day === 5 && hour >= 21) return false;      // Friday from 21:00: closed
  return true;
}
const { validate } = require('./config');
const { initialLoad } = require('./loader');
const { runFullQualityCheck } = require('./quality');
const { repairAll } = require('./repair');
const { hourlyUpdate, runAnalysis } = require('./updater');
const { backfillStrength, calculateLatestStrength } = require('./strength');
const { backfillSmooth } = require('./smooth');
const { backfillSpreads, rankPairs } = require('./spread');
const { backfillStates, printLatestStates } = require('./stateDetect');
const { backfillSignals, printLatestSignals } = require('./signals');
const { backfillRiskChecks, printRiskReport } = require('./risk');
const { analyzeActiveSetups } = require('./aiAnalysis');
const { calculateLatestSentiment } = require('./riskSentiment');
const { writeJournalEntry } = require('./journalEngine');
const { runOutcomeReviews } = require('./outcomeReview');
const { backfillSessionActivity } = require('./sessionActivity');

async function phase1() {
  validate();

  // Step 1: Initial load
  console.log('=== PHASE 1: INITIAL LOAD ===');
  const loadSummary = await initialLoad();

  const errors = loadSummary.filter(s => s.status === 'ERROR');
  if (errors.length > 0) {
    console.error(`${errors.length} instruments failed to load. Fix and retry.`);
    process.exit(1);
  }

  // Step 2: Quality check
  console.log('\n=== PHASE 1: QUALITY CHECK ===');
  const { check, results } = await runFullQualityCheck();
  console.log(`Expected: ${check.expected_candles}, Found: ${check.found_candles}, Missing: ${check.missing_candles}`);

  // Step 3: Repair if needed
  if (check.status !== 'CLEAN') {
    console.log('\n=== PHASE 1: REPAIR ===');
    const repair = await repairAll();

    if (repair.status !== 'ALL_CLEAN') {
      console.error('PHASE 1 FAILED: Could not repair all gaps. System halted.');
      process.exit(1);
    }

    // Step 4: Final quality check
    console.log('\n=== PHASE 1: FINAL QUALITY CHECK ===');
    const { check: finalCheck } = await runFullQualityCheck();

    if (finalCheck.status !== 'CLEAN') {
      console.error('PHASE 1 FAILED: Data still not clean after repair. System halted.');
      process.exit(1);
    }
  }

  console.log('\n=== PHASE 1 COMPLETE: ALL DATA CLEAN ===');

  // Step 5: Backfill strength for all historical candles
  console.log('\n=== PHASE 2: BACKFILL STRENGTH ===');
  await backfillStrength();

  // Step 6: Backfill smoothing
  console.log('\n=== PHASE 3: BACKFILL SMOOTHING ===');
  await backfillSmooth();

  // Step 7: Backfill spreads
  console.log('\n=== PHASE 4: BACKFILL SPREADS ===');
  await backfillSpreads();

  // Step 8: Backfill market states
  console.log('\n=== PHASE 5: BACKFILL STATES ===');
  await backfillStates();

  // Step 9: Backfill signals
  console.log('\n=== PHASE 6: BACKFILL SIGNALS ===');
  await backfillSignals();

  // Step 10: Backfill risk checks
  console.log('\n=== PHASE 7: BACKFILL RISK CHECKS ===');
  await backfillRiskChecks();

  // Step 6: Schedule hourly updates
  console.log('Scheduling hourly updates at minute 5 past each hour...');
  cron.schedule('5 * * * *', async () => {
    try {
      const result = await hourlyUpdate();
      if (result.status === 'FAILED') {
        console.error('[CRON] Hourly update failed. Manual intervention needed.');
      }
    } catch (err) {
      console.error(`[CRON] Unexpected error: ${err.message}`);
    }
  });

  console.log('NervaFX Phase 1 running. Hourly updates scheduled.');
}

const command = process.argv[2];

if (command === 'load') {
  validate();
  initialLoad().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'check') {
  validate();
  runFullQualityCheck().then(({ check }) => {
    console.log(JSON.stringify(check, null, 2));
    process.exit(check.status === 'CLEAN' ? 0 : 1);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'repair') {
  validate();
  repairAll().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.status === 'ALL_CLEAN' ? 0 : 1);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'update') {
  validate();
  if (!isMarketOpen()) {
    // Market closed — skip OANDA fetch but still run AI analysis on existing data
    console.log(`[UPDATE] Market closed (${new Date().toUTCString()}). Running AI analysis only.`);
    analyzeActiveSetups()
      .then(() => process.exit(0))
      .catch(err => { console.error(err); process.exit(1); });
  } else {
    hourlyUpdate().then(r => {
      console.log(`[UPDATE] status: ${r.status}`);
      process.exit(r.status === 'FAILED' ? 1 : 0);
    }).catch(err => { console.error(err); process.exit(1); });
  }
} else if (command === 'ai') {
  // Standalone AI analysis — useful for testing, always runs regardless of market hours
  validate();
  analyzeActiveSetups()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
} else if (command === 'backfill') {
  validate();
  backfillStrength().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'strength') {
  validate();
  calculateLatestStrength().then(r => {
    console.log(JSON.stringify({ time: r.time, rows: r.rows }, null, 2));
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'smooth') {
  validate();
  backfillSmooth().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'spreads') {
  validate();
  backfillSpreads().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'states') {
  validate();
  backfillStates().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'market') {
  validate();
  printLatestStates().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'signal-backfill') {
  validate();
  backfillSignals().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'signals') {
  validate();
  printLatestSignals().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'risk-backfill') {
  validate();
  backfillRiskChecks().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'risk') {
  validate();
  printRiskReport().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'sentiment') {
  validate();
  calculateLatestSentiment().then(r => {
    console.log(`\nRisk Sentiment: ${r.sentiment} (net: ${r.net_score}, conf: ${r.confidence}%)`);
    console.log(`  Equity: ${r.equity_score}  JPY: ${r.jpy_score}  CHF: ${r.chf_score}`);
    console.log(`  Gold: ${r.gold_score}  Silver: ${r.silver_score}  Oil: ${r.oil_score}`);
    console.log(`  AUD/JPY: ${r.audjpy_score}  NZD/JPY: ${r.nzdjpy_score}`);
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'analyze') {
  validate();
  runAnalysis().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'journal') {
  validate();
  writeJournalEntry().then(r => {
    console.log(`\n[JOURNAL] Summary: ${r.summary}`);
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'outcomes') {
  validate();
  runOutcomeReviews().then(() => {
    console.log('[OUTCOMES] Review complete.');
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'session-activity') {
  validate();
  backfillSessionActivity().then(r => {
    console.log(`[SESSION_ACTIVITY] Backfill complete: ${r?.rows ?? 0} hourly rows.`);
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else if (command === 'rank') {
  validate();
  rankPairs().then(pairs => {
    console.log('\nPair Strength Ranking (by abs spread_6h):');
    console.log('─'.repeat(52));
    pairs.forEach((p, i) => {
      const s6 = Number(p.spread_6h).toFixed(6);
      const s12 = Number(p.spread_12h).toFixed(6);
      console.log(`${String(i+1).padStart(2)}. ${p.instrument.padEnd(8)} ${p.bias.padEnd(5)} 6h: ${s6}  12h: ${s12}`);
    });
    process.exit(0);
  }).catch(err => { console.error(err); process.exit(1); });
} else {
  phase1().catch(err => { console.error(err); process.exit(1); });
}
