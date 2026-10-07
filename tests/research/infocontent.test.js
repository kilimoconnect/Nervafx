'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  registrationHash, decideHypothesis, holm, outcomeR, weekBlockCI, evaluate, atr14, stateEpisodes, M15,
} = require('../../research/m15/infocontent');
const prereg = require('../../research/m15/infocontent_prereg');

// ── pre-registration is frozen & hashed ───────────────────────────────────────
test('registration hash is deterministic and matches the frozen prereg', () => {
  assert.equal(registrationHash, prereg.registrationHash);
  assert.equal(registrationHash.length, 64);
  assert.equal(prereg.PREREGISTRATION.verdictSpace.length, 3);
});

// ── gate: ELIGIBLE / REJECT / INSUFFICIENT behave as registered ───────────────
test('gate returns ELIGIBLE only when ALL registered conditions hold on REAL holdout', () => {
  const good = { provenance: 'REAL_HOLDOUT', nEpisodes: 300, nWeeks: 12, coveragePartial: false, ciLow: 0.05, ciHigh: 0.20, holmReject: true, beatsControls: true, posWeekShare: 0.70, maxConcentration: 0.30 };
  assert.equal(decideHypothesis(good).verdict, 'ELIGIBLE_FOR_NEW_SHADOW_REVIEW');
});
test('gate REJECTs when the CI is entirely ≤ 0', () => {
  const bad = { provenance: 'REAL_HOLDOUT', nEpisodes: 300, nWeeks: 12, ciLow: -0.2, ciHigh: -0.01, holmReject: false, beatsControls: false, posWeekShare: 0.2, maxConcentration: 0.3 };
  assert.equal(decideHypothesis(bad).verdict, 'REJECT');
});
test('gate is INSUFFICIENT on too few episodes, few weeks, or Holm failure', () => {
  assert.equal(decideHypothesis({ provenance: 'REAL_HOLDOUT', nEpisodes: 50, nWeeks: 12, ciLow: 0.1, ciHigh: 0.2, holmReject: true, beatsControls: true, posWeekShare: 0.8, maxConcentration: 0.2 }).verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(decideHypothesis({ provenance: 'REAL_HOLDOUT', nEpisodes: 300, nWeeks: 4, ciLow: 0.1, ciHigh: 0.2, holmReject: true, beatsControls: true, posWeekShare: 0.8, maxConcentration: 0.2 }).verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(decideHypothesis({ provenance: 'REAL_HOLDOUT', nEpisodes: 300, nWeeks: 12, ciLow: 0.1, ciHigh: 0.2, holmReject: false, beatsControls: true, posWeekShare: 0.8, maxConcentration: 0.2 }).verdict, 'INSUFFICIENT_EVIDENCE');
});
test('SYNTHETIC/EXPLORATORY data can NEVER be eligible, even with perfect stats', () => {
  const perfect = { provenance: 'SYNTHETIC_EXPLORATORY', nEpisodes: 10000, nWeeks: 52, ciLow: 0.3, ciHigh: 0.9, holmReject: true, beatsControls: true, posWeekShare: 1, maxConcentration: 0.1 };
  assert.equal(decideHypothesis(perfect).verdict, 'INSUFFICIENT_EVIDENCE');
});

// ── Holm-Bonferroni across the family ─────────────────────────────────────────
test('Holm adjustment rejects in order and stops at the first failure', () => {
  const r = holm({ H1: 0.001, H2: 0.2, H3: 0.04 });
  assert.equal(r.H1, true);     // 0.001 ≤ 0.05/3
  assert.equal(r.H3, false);    // 0.04 > 0.05/2 ⇒ stop
  assert.equal(r.H2, false);
});

// ── outcome: next-open entry, no same-bar, cost reduces R, correct sign ───────
test('outcomeR enters at the NEXT candle open and subtracts cost', () => {
  const c = []; for (let i = 0; i < 20; i++) c.push({ openMs: i * M15, open: 1.0 + i * 0.001, high: 1.0 + i * 0.001 + 0.0005, low: 1.0 + i * 0.001 - 0.0005, close: 1.0 + i * 0.001 });
  const gross = outcomeR(c, 5, 3, 1, { spread: 0 });
  const net = outcomeR(c, 5, 3, 1, { spread: 0.0005 });
  assert.equal(gross.entryIdx, 6);                 // signalIdx+1 (never same bar)
  assert.equal(gross.exitIdx, 9);
  assert.ok(gross.grossR > 0);                     // up series, long dir
  assert.ok(net.netR < gross.netR);               // cost reduces R
  const short = outcomeR(c, 5, 3, -1, { spread: 0 });
  assert.ok(short.grossR < 0);                     // short an up series
});

// ── week-block bootstrap is seeded/deterministic ──────────────────────────────
test('weekBlockCI is deterministic for a fixed seed', () => {
  const s = []; for (let i = 0; i < 40; i++) s.push({ v: (i % 5) - 2, week: `2026-W${10 + (i % 8)}` });
  const a = weekBlockCI(s, 20261007), b = weekBlockCI(s, 20261007);
  assert.deepEqual(a, b);
  assert.ok(a.weeks >= 2 && a.ciLow != null);
});

// ── evaluate preserves NONE PASSED and never eligible on synthetic ────────────
test('evaluate on synthetic data ⇒ all INSUFFICIENT, NONE PASSED preserved', () => {
  const candles = []; for (let i = 0; i < 60; i++) candles.push({ openMs: i * M15, open: 0.86 - i * 0.0006, high: 0.86 - i * 0.0006 + 0.0004, low: 0.86 - i * 0.0006 - 0.0004, close: 0.86 - i * 0.0006 });
  const frames = candles.map((c, i) => ({ candleIdx: i, asOfCloseMs: c.openMs + M15, primaryState: i > 10 ? 'ACCEPTED_TREND_DOWN' : 'EMERGING_MOVE_DOWN', priceOnlyState: 'EMERGING_MOVE_DOWN', confirmed: i > 10, newEvents: [] }));
  const rep = evaluate([{ pair: 'EUR_GBP', candles, frames }], { provenance: 'SYNTHETIC_EXPLORATORY', horizon: 4, scenario: { spread: 0.0001 } });
  for (const h of ['H1', 'H2', 'H3']) assert.equal(rep.hypotheses[h].verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(rep.stage5Preserved.decision, 'NONE PASSED');
  assert.equal(rep.stage5Preserved.immutable, true);
  assert.equal(rep.registrationHash, registrationHash);
  assert.ok(/NOT proof/.test(rep.disclaimer));
});

// ── ATR sanity ────────────────────────────────────────────────────────────────
test('atr14 is positive on a moving series and 0 on a flat one', () => {
  const up = []; for (let i = 0; i < 20; i++) up.push({ openMs: i * M15, open: 1 + i * 0.01, high: 1 + i * 0.01 + 0.005, low: 1 + i * 0.01 - 0.005, close: 1 + i * 0.01 });
  const flat = []; for (let i = 0; i < 20; i++) flat.push({ openMs: i * M15, open: 1, high: 1, low: 1, close: 1 });
  assert.ok(atr14(up, 15) > 0);
  assert.equal(atr14(flat, 15), 0);
});
