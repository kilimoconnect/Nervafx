'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { splitTrainEval, blockBootstrapCI, foldByWeek, compareIncremental, clusterConcentration, decide } = require('../../research/m15/walkforward');

const DAY = 24 * 3600e3, T0 = Date.UTC(2026, 6, 1, 0, 0, 0);
function recs(n, netRFn, pair = 'EUR_USD', startMs = T0) { const [base, quote] = pair.split('_'); const out = []; for (let i = 0; i < n; i++) out.push({ label: 'FILLED', netR: { typical: netRFn(i) }, signalMs: startMs + i * DAY, pair, base, quote, direction: 'LONG' }); return out; }

test('block bootstrap CI is deterministic (seeded) and reflects the mean sign', () => {
  const neg = recs(60, () => -0.3 + (Math.random() - 0.5) * 0);   // constant negative
  const a = blockBootstrapCI(neg, { seed: 7 }), b = blockBootstrapCI(neg, { seed: 7 });
  assert.deepEqual(a, b);                                          // deterministic
  assert.ok(a.ciHigh < 0);                                        // CI entirely below 0
});

test('splitTrainEval respects the boundary and embargo', () => {
  const r = recs(40, () => 0.1);
  const { boundaryMs, train, evalR } = splitTrainEval(r, { fraction: 0.5 });
  assert.ok(train.every((x) => x.signalMs < boundaryMs));
  assert.ok(evalR.every((x) => x.signalMs >= boundaryMs));
  assert.ok(train.length + evalR.length < r.length);              // embargo drops a boundary band
});

test('foldByWeek reports per-week means and positive-fold share', () => {
  const r = recs(35, (i) => (i % 10 < 5 ? 0.2 : -0.2));           // spans several weeks
  const f = foldByWeek(r);
  assert.ok(f.folds.length >= 4);
  assert.ok(f.positiveFoldShare >= 0 && f.positiveFoldShare <= 1);
});

test('compareIncremental: an additive gate that removes baseline episodes', () => {
  const base = recs(10, () => 0.1);
  const add = base.slice(0, 4);                                    // gate keeps 4 of 10, adds none
  const c = compareIncremental(base, add);
  assert.equal(c.removed, 6); assert.equal(c.added, 0); assert.equal(c.sharedFilled, 4);
});

test('clusterConcentration flags one-currency dependence', () => {
  const all = recs(20, () => 0.1, 'EUR_USD');                     // every episode touches EUR and USD
  assert.equal(clusterConcentration(all), 1);                     // 20/20 touch USD
});

test('decide: too few OOS ⇒ INSUFFICIENT_EVIDENCE', () => {
  const s = { evalCI: { n: 12, ciLow: 0.1, ciHigh: 0.3 } };
  assert.equal(decide(s).verdict, 'INSUFFICIENT_EVIDENCE');
});

test('decide: negative OOS not beating control ⇒ REJECT', () => {
  const s = { evalCI: { n: 200, ciLow: -0.4, ciHigh: -0.1 }, evalMeanNetR: -0.25, baselineEvalMeanNetR: -0.2, controlEvalMeanNetR: -0.3, positiveFoldShare: 0.2, clusterConcentration: 0.4 };
  assert.equal(decide(s).verdict, 'REJECT');
});

test('decide: strong positive stable OOS ⇒ SELECT_FOR_SHADOW (never PROVEN_PROFITABLE)', () => {
  const s = { evalCI: { n: 200, ciLow: 0.12, ciHigh: 0.45 }, evalMeanNetR: 0.28, baselineEvalMeanNetR: 0.05, controlEvalMeanNetR: -0.3, positiveFoldShare: 0.8, clusterConcentration: 0.35 };
  const d = decide(s);
  assert.equal(d.verdict, 'SELECT_FOR_SHADOW');
  assert.notEqual(d.verdict, 'PROVEN_PROFITABLE');
});
