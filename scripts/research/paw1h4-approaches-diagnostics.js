'use strict';

/**
 * PA_W1_H4_MULTI diagnostics (read-only; no deploy/push). Current-snapshot across the
 * 28 majors: candidate counts by approach × state, confirmed candidates, and a
 * first-rejection-reason funnel. Historical economic evaluation of the new approaches
 * is deferred and must be done on UNSEEN data (this snapshot is exploratory).
 *
 *   node scripts/research/paw1h4-approaches-diagnostics.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { loadH1Parallel } = require('../../research/paw1h4/dbload');
const { evaluateApproaches } = require('../../research/paw1h4/approaches');
const { CONFIG, PAIRS } = require('../../research/paw1h4/config');

async function main() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const pairs = process.argv[2] ? process.argv[2].split(',') : PAIRS;
  console.error(`Loading H1 for ${pairs.length} pairs…`);
  const all = await loadH1Parallel(sb, pairs, { fromIso: new Date(Date.now() - 500 * 24 * 60 * 60 * 1000).toISOString() }, 8);

  const byApproachState = {}, funnel = {}, confirmed = [], byPair = {};
  let span = { from: null, to: null };
  for (const p of pairs) {
    const h1 = all[p]; if (!h1 || !h1.length) continue;
    if (!span.from || h1[0].openMs < Date.parse(span.from)) span.from = new Date(h1[0].openMs).toISOString();
    if (!span.to || h1[h1.length - 1].openMs > Date.parse(span.to)) span.to = new Date(h1[h1.length - 1].openMs).toISOString();
    const t = h1[h1.length - 1].closeMs;
    let ev; try { ev = evaluateApproaches(h1, p, t, CONFIG); } catch (e) { continue; }
    byPair[p] = {};
    for (const c of ev.candidates) {
      const a = c.approach;
      byApproachState[a] = byApproachState[a] || {};
      byApproachState[a][c.state] = (byApproachState[a][c.state] || 0) + 1;
      byPair[p][a + ':' + (c.dir || '-')] = c.state;
      const first = c.rejectionReasons[0] || 'none';
      funnel[first] = (funnel[first] || 0) + 1;
      if (c.state === 'CONFIRMED') confirmed.push({ pair: p, approach: a, dir: c.dir, rewardRisk: c.economics && c.economics.rewardRisk, objective: c.objective, invalidation: c.invalidation });
    }
  }

  const report = {
    strategyId: 'PA_W1_H4_MULTI', version: 'w1h4-multi-1.0.0', generatedAt: new Date().toISOString(),
    inspectedData: { pairs: pairs.length, h1Span: span, note: 'Current-snapshot (latest completed H4 close per pair). EXPLORATORY — a later evaluation on UNSEEN data is required. Economics are mid-only estimated; the 2:1 gate is a research eligibility rule, not a profitability claim.' },
    candidateCountsByApproachState: byApproachState,
    confirmedCandidates: confirmed,
    firstRejectionFunnel: funnel,
    byPair,
  };
  const out = path.join(__dirname, '..', '..', 'docs', 'research', 'paw1h4_approaches_diagnostics.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.error('\n=== PA_W1_H4_MULTI diagnostics (current snapshot) ===');
  for (const a of Object.keys(byApproachState)) console.error('  ' + a.padEnd(18), JSON.stringify(byApproachState[a]));
  console.error('  confirmed now:', confirmed.length, confirmed.map((c) => c.pair + '/' + c.approach + ' ' + c.dir + ' RR' + c.rewardRisk).join(' | '));
  console.error('  first-rejection funnel:', JSON.stringify(funnel));
  console.error(`\nWrote ${out}`);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
