'use strict';

/**
 * Phase 5 — reversible snapshot integrity test against the APPLIED m15i_ schema.
 *
 * Exercises the REAL writer (api/m15-snapshot.writeOne) for the latest completed
 * M15 close, then verifies: COMPLETE status + 28 pairs, stored-vs-recompute parity
 * (live == replay at the same close+version), and idempotency (a second run adds
 * no duplicate). It DELETES its own test rows afterwards to restore the empty
 * state — it does not activate scheduling and leaves no residual data. No orders.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { CONFIG_1_1_0A } = require('../../api/_m15/config-1_1_0');
const { latestCompletedM15Ms, M15_MS } = require('../../api/_m15/data');
const { loadSynchronized } = require('../../api/_m15/load');
const { runNetwork } = require('../../api/_m15/coordinator');
const snap = require('../../api/m15-snapshot');

const CFG = CONFIG_1_1_0A;

function env() { const t = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8'); const e = {}; for (const l of t.split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); } return e; }

async function count(sb, table, srcIso, version) {
  const { count } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source_candle_time', srcIso).eq('calculation_version', version);
  return count || 0;
}

async function main() {
  const e = env(); const sb = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY);
  const nowMs = Date.now();
  // Use the last real weekday close (weekend calendar frames correctly SKIP now).
  const frame = process.argv[2] ? Date.parse(process.argv[2]) : latestCompletedM15Ms(nowMs, CFG);
  const srcIso = new Date(frame).toISOString();
  const closeIso = new Date(frame + M15_MS).toISOString();
  const { configHash } = require('../../api/_m15/config');
  const fullVersion = `${CFG.version}+${configHash(CFG)}`;
  const out = { frameOpen: srcIso, close: closeIso, version: fullVersion, checks: {} };

  try {
    // pre: tables empty for this frame
    const pre = await count(sb, 'm15i_analysis_runs', srcIso, fullVersion);
    out.checks.preRows = pre;

    // 1) run the REAL writer
    const w1 = await snap.writeOne(sb, frame, nowMs);
    out.writer = w1;

    // 2) read back the stored run + rankings
    const { data: runRow } = await sb.from('m15i_analysis_runs').select('*').eq('source_candle_time', srcIso).eq('calculation_version', fullVersion).limit(1);
    const stored = runRow && runRow[0];
    out.checks.statusComplete = stored && stored.status === 'COMPLETE';
    out.checks.pairsProcessed = stored && stored.pairs_processed;
    out.checks.hasCloseTime = !!(stored && stored.close_time);

    const { data: storedRanks } = await sb.from('m15i_pair_rankings').select('instrument,decision,rank').eq('source_candle_time', srcIso).eq('calculation_version', fullVersion);
    out.checks.rankingRows = (storedRanks || []).length;

    // 3) recompute the SAME close (replay) and compare decisions (parity)
    const { evalMs, candlesByPair } = await loadSynchronized(sb, { atMs: frame + M15_MS, cfg: CFG });
    const re = runNetwork(candlesByPair, { evalMs, cfg: CFG, diagnostics: true });
    let mism = 0;
    const byPair = Object.fromEntries((storedRanks || []).map((r) => [r.instrument, r.decision]));
    for (const p of Object.keys(re.pairs)) if (byPair[p] !== undefined && byPair[p] !== re.pairs[p].decision) mism++;
    out.checks.parityFrameMatches = evalMs === frame;
    out.checks.parityDecisionMismatches = mism;         // expect 0

    // 4) idempotency: run again, run-row count stays 1
    await snap.writeOne(sb, frame, nowMs);
    out.checks.runRowsAfterSecondWrite = await count(sb, 'm15i_analysis_runs', srcIso, fullVersion); // expect 1

    // notifications for this close (dedup): count
    const { count: nCount } = await sb.from('m15i_notifications').select('*', { count: 'exact', head: true }).eq('source_candle_time', srcIso);
    out.checks.notificationRows = nCount || 0;
  } finally {
    // 5) CLEANUP — delete only the rows this test created (restore empty state)
    const tables = ['m15i_pair_states', 'm15i_pair_rankings', 'm15i_setups', 'm15i_currency_strength', 'm15i_currency_power', 'm15i_currency_structure', 'm15i_analysis_runs'];
    for (const t of tables) { await sb.from(t).delete().eq('source_candle_time', srcIso).eq('calculation_version', fullVersion).then(() => {}, () => {}); }
    await sb.from('m15i_notifications').delete().eq('source_candle_time', srcIso).then(() => {}, () => {});
    const leftover = await count(sb, 'm15i_analysis_runs', srcIso, fullVersion);
    out.checks.rowsAfterCleanup = leftover;            // expect 0
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
