'use strict';

/**
 * Stage 5 — time-respecting comparison from Stage 4 per-episode records. Selects any
 * variant on the CALIBRATION (earlier) split and reports the EVALUATION (later)
 * split with block(week)-bootstrap CIs; compares A-family additions incrementally;
 * applies the documented decision standard. No winner is invented; "none passed" is
 * an allowed outcome. Reproducible: reads docs/research/stage4_episodes.json.
 */

const fs = require('fs');
const path = require('path');
const wf = require('../../research/m15/walkforward');
const { REGISTRY } = require('../../research/m15/candidates');

const IN = path.join(__dirname, '..', '..', 'docs', 'research', 'stage4_episodes.json');
const OUT = path.join(__dirname, '..', '..', 'docs', 'research');
const mean = wf.mean;

function selectVariantAndEval(recsAll) {
  // group by variant, pick best TRAIN mean netR (calibration), evaluate OOS on later split
  const byVar = {}; for (const r of recsAll) (byVar[r.variant] = byVar[r.variant] || []).push(r);
  let best = null;
  for (const v of Object.keys(byVar)) {
    const { train, evalR } = wf.splitTrainEval(byVar[v], { fraction: 0.5 });
    const tf = train.filter(wf.filled), tMean = tf.length ? mean(tf.map((r) => r.netR.typical)) : -Infinity;
    if (!best || tMean > best.trainMean) best = { variant: v, trainMean: tMean, train, evalR };
  }
  return best;
}

function scoreFamily(id, recsById, baselineEvalMean, controlEvalMean) {
  const recs = recsById[id] || [];
  if (!recs.length) return { id, totalEpisodes: 0, evalMeanNetR: null, evalCI: { n: 0, ciLow: null, ciHigh: null }, positiveFoldShare: null, clusterConcentration: null, verdict: 'INSUFFICIENT_EVIDENCE', reasons: ['no episodes in window'] };
  const sel = selectVariantAndEval(recs);
  const evalFilled = sel.evalR.filter(wf.filled);
  const evalCI = wf.blockBootstrapCI(sel.evalR, { seed: 4242 });
  const fold = wf.foldByWeek(sel.evalR);
  const s = {
    id, selectedVariant: sel.variant, totalEpisodes: recs.length,
    trainMeanNetR: sel.trainMean === -Infinity ? null : +sel.trainMean.toFixed(3),
    evalMeanNetR: evalFilled.length ? +mean(evalFilled.map((r) => r.netR.typical)).toFixed(3) : null,
    evalCI, positiveFoldShare: fold.positiveFoldShare, folds: fold.folds.length,
    clusterConcentration: wf.clusterConcentration(sel.evalR),
    baselineEvalMeanNetR: baselineEvalMean, controlEvalMeanNetR: controlEvalMean,
  };
  const d = wf.decide(s, { minEpisodes: 30 });
  return { ...s, verdict: d.verdict, reasons: d.reasons };
}

function main() {
  if (!fs.existsSync(IN)) { console.error('stage4_episodes.json not found — run scripts/research/backtest-run.js first'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const recsById = {}; for (const r of data.records) (recsById[r.candidate] = recsById[r.candidate] || []).push(r);

  // baseline (A0) + control eval means for the decision standard
  const a0 = selectVariantAndEval(recsById['A0_baseline_dir10'] || [{ variant: '{}', netR: null, label: 'x', signalMs: 0 }]);
  const a0eval = (a0.evalR || []).filter(wf.filled);
  const baselineEvalMean = a0eval.length ? +mean(a0eval.map((r) => r.netR.typical)).toFixed(3) : null;
  const ctl = selectVariantAndEval(recsById['CTRL_pseudo_random'] || []);
  const ctlEval = (ctl.evalR || []).filter(wf.filled);
  const controlEvalMean = ctlEval.length ? +mean(ctlEval.map((r) => r.netR.typical)).toFixed(3) : null;

  const families = ['A0_baseline_dir10', 'A1_dir10_plus_consistency', 'A2_plus_breadth', 'A3_plus_structure_energy', 'B_continuation_4after10', 'C_early_expansion', 'D_first_pullback', 'E_compression_release', 'F_failed_extension', 'CTRL_pseudo_random', 'NULL_no_signal'];
  const scorecard = families.map((id) => scoreFamily(id, recsById, baselineEvalMean, controlEvalMean));

  // incremental A-ladder comparison (one change at a time)
  const pick = (id) => { const s = selectVariantAndEval(recsById[id] || []); const v = s && s.variant; return (recsById[id] || []).filter((r) => r.variant === v); };
  const ladder = [['A0_baseline_dir10', 'A1_dir10_plus_consistency'], ['A1_dir10_plus_consistency', 'A2_plus_breadth'], ['A2_plus_breadth', 'A3_plus_structure_energy']]
    .map(([b, a]) => ({ from: b, to: a, ...wf.compareIncremental(pick(b), pick(a)) }));

  const selected = scorecard.filter((s) => s.verdict === 'SELECT_FOR_SHADOW');
  const out = {
    generatedAt: new Date().toISOString(), window: data.window, researchVersion: REGISTRY.version,
    decisionStandard: 'positive OOS net economics (CI>0), gain over simpler baseline, beats control, fold-stable (≥60% positive weeks), not one-currency (≤50%), ≥30 OOS episodes. Verdicts: SELECT_FOR_SHADOW | REJECT | INSUFFICIENT_EVIDENCE. Never PROVEN_PROFITABLE.',
    baselineEvalMeanNetR: baselineEvalMean, controlEvalMeanNetR: controlEvalMean,
    trialRegistry: { candidates: REGISTRY.candidates.length, totalVariants: REGISTRY.variantBudget.totalParameterVariants },
    scorecard, incrementalLadder: ladder,
    shadowCandidate: selected.length === 1 ? selected[0].id : null,
    conclusion: selected.length === 1 ? `SELECT_FOR_SHADOW: ${selected[0].id}` : (selected.length === 0 ? 'NONE PASSED — no candidate meets the standard; continue observation (post-freeze shadow).' : 'MULTIPLE passed — prefer the simplest; not auto-selected.'),
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'stage5_scorecard.json'), JSON.stringify(out, null, 2));
  console.log('window', JSON.stringify(data.window), '| baselineOOS', baselineEvalMean, '| controlOOS', controlEvalMean);
  for (const s of scorecard) console.log(`${s.id.padEnd(30)} eps ${String(s.totalEpisodes).padStart(5)} evalOOS ${String(s.evalMeanNetR).padStart(7)} CI[${s.evalCI?.ciLow},${s.evalCI?.ciHigh}] posFold ${s.positiveFoldShare} => ${s.verdict}`);
  console.log('\nCONCLUSION:', out.conclusion);
  console.log('wrote docs/research/stage5_scorecard.json');
}
main();
