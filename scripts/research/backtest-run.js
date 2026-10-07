'use strict';

/**
 * Stage 4 — read-only every-M15-close offline replay driver. Loads the verified
 * range once, streams closes chronologically (no lookahead in decisions), records
 * episodes with TWO denominators (pair-at-close evals; unique episodes), then
 * simulates the predeclared REFERENCE outcome (mid-only ⇒ estimated) under spread
 * and manual-delay scenarios. No production writes; not a Vercel request.
 *
 * Run: node scripts/research/backtest-run.js --from 2026-07-27 --to 2026-09-25
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { M15, PAIRS, loadAllPairsFromDb, syncAsOf } = require('../../research/m15/loader');
const { featureSnapshot } = require('../../research/m15/featureSnapshot');
const { REGISTRY } = require('../../research/m15/candidates');
const { simulateReference, forwardMovement, atrAt, pipOf } = require('../../research/m15/backtest');
const { runNetwork } = require('../../api/_m15/coordinator');
const { CONFIG_1_1_0A } = require('../../api/_m15/config-1_1_0');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const FROM = arg('from', '2026-07-27'), TO = arg('to', '2026-09-25');
const CFG = CONFIG_1_1_0A, TIMEOUT = 8, SPREADS = { mid0: 0, typical: 1.2, stress2x: 2.4 };
function env() { const t = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8'); const e = {}; for (const l of t.split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)\s*=\s*(.*)$/); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); } return e; }
function sessionOf(ms) { const h = new Date(ms).getUTCHours(); return h < 7 ? 'TOKYO' : h < 12 ? 'LONDON' : h < 16 ? 'LONDON_NY' : h < 21 ? 'NEWYORK' : 'OFF'; }
function idxOf(map, ms) { return map[ms]; }

async function main() {
  const e = env(); const sb = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY);
  const fromMs = Date.parse(FROM + 'T00:00:00Z'), toMs = Date.parse(TO + 'T21:00:00Z');
  const preIso = new Date(fromMs - 300 * M15).toISOString();       // warm-up pre-roll
  console.error(`loading ${preIso}..${TO} …`);
  const hist = await loadAllPairsFromDb(sb, { fromIso: preIso, toIso: new Date(toMs + 6 * M15).toISOString() });
  const idxMap = {}; for (const p of PAIRS) { idxMap[p] = {}; hist[p].forEach((c, i) => { idxMap[p][c.openMs] = i; }); }
  console.error('loaded; streaming closes …');

  const cands = REGISTRY.candidates;
  // per candidate: variant runs; each run has per-pair state + recorded entries
  const runs = [];
  for (const c of cands) for (const v of c.variants) runs.push({ id: c.id, family: c.family, ruleHash: c.ruleHash, variant: v, cand: c, open: {}, entries: [] });

  const firstClose = Math.ceil(fromMs / M15) * M15, lastClose = Math.floor(toMs / M15) * M15;
  let pairAtClose = 0, closesEvaluated = 0;
  for (let T = firstClose; T <= lastClose; T += M15) {
    const view = syncAsOf(hist, T); if (view.frameOpenMs == null || !view.aligned) continue;
    const evalMs = view.frameOpenMs;
    // AUDIT FIX (Stage 5A): evaluate a frame ONLY at its own close. Skips weekend/gap
    // T-steps where the newest completed candle is older than T (which previously
    // re-evaluated the same stale frame up to 193×, inflating closes and episodes).
    if (evalMs + M15 !== T) continue;
    // warm-up: need enough candles for features/prod
    if (PAIRS.some((p) => view.bySync[p].length < 60)) continue;
    const snap = featureSnapshot(hist, T);
    const prod = runNetwork(view.bySync, { evalMs, cfg: CFG, diagnostics: true });
    closesEvaluated++; pairAtClose += PAIRS.length;
    for (const r of runs) {
      for (const pair of PAIRS) {
        const ctx = { pair, closeMs: T, feat: snap.pairs[pair], net: snap.network[10], prod: prod.pairs[pair].diag, params: r.variant };
        const d = r.cand.decide(ctx);
        const ep = r.open[pair];
        if (!ep) {
          if (d.arm && d.direction) { r.open[pair] = { pair, direction: d.direction, firstMs: evalMs, age: 1, triggered: d.trigger }; if (d.trigger) r.entries.push({ pair, signalMs: evalMs, direction: d.direction, session: sessionOf(evalMs) }); }
          continue;
        }
        ep.age++;
        if (d.invalidate || (d.arm && d.direction && d.direction !== ep.direction)) { delete r.open[pair]; continue; }
        if (!ep.triggered && d.trigger && d.direction === ep.direction) { ep.triggered = true; r.entries.push({ pair, signalMs: evalMs, direction: ep.direction, session: sessionOf(evalMs) }); }
        if (ep.age > TIMEOUT) delete r.open[pair];
      }
    }
  }
  console.error(`streamed ${closesEvaluated} closes; simulating outcomes …`);

  // outcome pass (reference sim + forward movement), spread + delay scenarios
  const episodeRecords = [];      // per-episode records for Stage 5 folds + bootstrap
  const results = runs.map((r) => {
    const agg = { id: r.id, family: r.family, ruleHash: r.ruleHash, variant: r.variant,
      episodes: r.entries.length, filled: 0, stale: 0, noData: 0,
      dirAcc: { 4: [0, 0], 6: [0, 0], 8: [0, 0], 10: [0, 0] }, fwdPips: { 4: [], 6: [], 8: [], 10: [] },
      netR: { mid0: [], typical: [], stress2x: [] }, netR_delay2: [], grossPips: [], maeR: [], mfeR: [],
      bySession: {}, byBase: {}, byQuote: {}, ambiguous: 0 };
    for (const s of r.entries) {
      const cs = hist[s.pair], si = idxOf(idxMap[s.pair], s.signalMs); if (si == null) continue;
      const pip = pipOf(s.pair), atr = atrAt(cs, si);
      const [b, q] = s.pair.split('_');
      const dc = {};
      for (const N of [4, 6, 8, 10]) { const f = forwardMovement(cs, si, s.direction, N, { pip, atr }); if (f && !f.gap) { agg.dirAcc[N][1]++; if (f.dirCorrect) agg.dirAcc[N][0]++; agg.fwdPips[N].push(f.pips); dc[N] = f.dirCorrect; } }
      const o0 = simulateReference(cs, si, s.direction, { pip, atr, stopMult: 1, delayCandles: 1, holdCandles: 4, spreadPips: SPREADS.mid0 });
      const rec = { candidate: r.id, family: r.family, ruleHash: r.ruleHash, variant: JSON.stringify(r.variant), pair: s.pair, base: b, quote: q, signalMs: s.signalMs, signalIso: new Date(s.signalMs).toISOString(), direction: s.direction, session: s.session, label: o0.label, dirCorrect: dc };
      if (o0.label === 'STALE_GAP_EXCLUDED') { agg.stale++; episodeRecords.push(rec); continue; }
      if (o0.label !== 'FILLED') { agg.noData++; episodeRecords.push(rec); continue; }
      agg.filled++; if (o0.ambiguous) agg.ambiguous++;
      agg.netR.mid0.push(o0.netR); agg.grossPips.push(o0.grossPips); agg.maeR.push(o0.maeR); agg.mfeR.push(o0.mfeR);
      const nT = simulateReference(cs, si, s.direction, { pip, atr, spreadPips: SPREADS.typical }).netR;
      const nS = simulateReference(cs, si, s.direction, { pip, atr, spreadPips: SPREADS.stress2x }).netR;
      const d2 = simulateReference(cs, si, s.direction, { pip, atr, delayCandles: 2, spreadPips: SPREADS.typical });
      agg.netR.typical.push(nT); agg.netR.stress2x.push(nS); if (d2.label === 'FILLED') agg.netR_delay2.push(d2.netR);
      agg.bySession[s.session] = (agg.bySession[s.session] || 0) + 1; agg.byBase[b] = (agg.byBase[b] || 0) + 1; agg.byQuote[q] = (agg.byQuote[q] || 0) + 1;
      rec.netR = { mid0: o0.netR, typical: nT, stress2x: nS, delay2: d2.label === 'FILLED' ? d2.netR : null };
      rec.grossPips = o0.grossPips; rec.ambiguous = !!o0.ambiguous;
      episodeRecords.push(rec);
    }
    const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const winRate = (a) => a.length ? a.filter((x) => x > 0).length / a.length : null;
    const dacc = {}; for (const N of [4, 6, 8, 10]) dacc[N] = agg.dirAcc[N][1] ? +(agg.dirAcc[N][0] / agg.dirAcc[N][1]).toFixed(3) : null;
    const fpips = {}; for (const N of [4, 6, 8, 10]) fpips[N] = mean(agg.fwdPips[N]) != null ? +mean(agg.fwdPips[N]).toFixed(2) : null;
    return {
      id: agg.id, family: agg.family, ruleHash: agg.ruleHash, variant: agg.variant,
      episodes: agg.episodes, filled: agg.filled, staleExcluded: agg.stale, noData: agg.noData, ambiguousShare: agg.filled ? +(agg.ambiguous / agg.filled).toFixed(3) : null,
      directionAccuracy: dacc, forwardMeanPips: fpips,
      economics_estimated: {
        avgNetR_mid0: mean(agg.netR.mid0) != null ? +mean(agg.netR.mid0).toFixed(3) : null,
        avgNetR_typical1p2: mean(agg.netR.typical) != null ? +mean(agg.netR.typical).toFixed(3) : null,
        avgNetR_stress2p4: mean(agg.netR.stress2x) != null ? +mean(agg.netR.stress2x).toFixed(3) : null,
        avgNetR_delay2: mean(agg.netR_delay2) != null ? +mean(agg.netR_delay2).toFixed(3) : null,
        winRate_typical: winRate(agg.netR.typical) != null ? +winRate(agg.netR.typical).toFixed(3) : null,
        avgGrossPips: mean(agg.grossPips) != null ? +mean(agg.grossPips).toFixed(2) : null,
        breakEvenSpreadPips: mean(agg.grossPips) != null ? +mean(agg.grossPips).toFixed(2) : null,   // net=0 when spread==avg gross pips
        avgMAE_R: mean(agg.maeR) != null ? +mean(agg.maeR).toFixed(3) : null, avgMFE_R: mean(agg.mfeR) != null ? +mean(agg.mfeR).toFixed(3) : null,
      },
      bySession: agg.bySession, byBaseCurrency: agg.byBase, byQuoteCurrency: agg.byQuote,
    };
  });

  const out = {
    generatedAt: new Date().toISOString(), window: { from: FROM, to: TO },
    engine: { engineVersion: 'm15-cfg-1.1.0a', researchVersion: REGISTRY.version, featureVersion: 'm15-feat-1.0.0', runVersion: 'stage4-run-1.1-timeaxis-fixed' },
    reference: { entry: 'open of next candle (delay 1)', stop: 'ATR14·1.0', hold: '4 M15 (1h)', spreadScenarios: SPREADS, note: 'MID-only ⇒ ALL economics ESTIMATED; intrabar stop resolved conservatively; parity vs stored snapshots UNTESTED (none recorded).' },
    denominators: { pairAtCloseEvaluations: pairAtClose, closesEvaluated, pairs: PAIRS.length, note: 'unique episodes per candidate below; correlated same-currency pairs are NOT independent successes.' },
    results,
  };
  const dir = path.join(__dirname, '..', '..', 'docs', 'research'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stage4_backtest.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, 'stage4_episodes.json'), JSON.stringify({ window: { from: FROM, to: TO }, engineVersion: 'm15-cfg-1.1.0a', reference: out.reference, records: episodeRecords }));
  console.error(`\npair-at-close evals ${pairAtClose} over ${closesEvaluated} closes`);
  for (const r of results.filter((x) => x.variant === (REGISTRY.byId[x.id].variants[0]))) console.error(`${r.id.padEnd(30)} eps ${String(r.episodes).padStart(4)} filled ${String(r.filled).padStart(4)} dirAcc10 ${r.directionAccuracy[10]} netR(typ) ${r.economics_estimated.avgNetR_typical1p2}`);
  console.error('wrote docs/research/stage4_backtest.json');
}
main().catch((e) => { console.error('RUN ERR', e.message, e.stack); process.exit(1); });
