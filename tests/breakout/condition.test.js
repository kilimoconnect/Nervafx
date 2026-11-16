'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildIndices } = require('../../research/comparison/index-build');
const { classify, windowMetrics, spreadExpands, conditionAll, currencyCondition } = require('../../research/breakout/condition');
const { strategyDef, DEFAULT_PARAMS, validParams } = require('../../research/breakout/config');
const { dayStart } = require('../../research/comparison/periods');
const { genData, cloneData, genM15, EAT_DAY0, HOUR, M15, CURRENCIES } = require('./fixtures');

const P = validParams(DEFAULT_PARAMS);           // breadthMin 5, deadbands 0
const DAILY = strategyDef('daily').condition;    // periodStart=dayStart, fast 4, slow 16

// ── §4 the zero-sum 1/8 index is genuinely zero-sum ──────────────────────────────────────────
test('zero-sum index: Σ ln(index_c) is invariant across all steps (zero-sum construction)', () => {
  const by = genM15(400, EAT_DAY0);
  const built = buildIndices(by);
  assert.ok(built.ok);
  const sumLn = (i) => CURRENCIES.reduce((s, c) => s + Math.log(built.index[c][i]), 0);
  const s0 = sumLn(0);
  for (let i = 1; i < built.timeline.length; i += 7) assert.ok(Math.abs(sumLn(i) - s0) < 1e-9, 'Σln invariant at ' + i);
});

// ── §6 classification matrix (recent-direction-only; period position never gates) ────────────
const win = (dir, eff, appr, depr) => ({ available: true, direction: dir, signedEff: eff, breadth: { appreciated: appr, depreciated: depr, unchanged: 7 - appr - depr } });

test('classify: both windows up + breadth + positive efficiency → strong', () => {
  assert.equal(classify(win('strengthening', 0.6, 6, 1), win('strengthening', 0.5, 5, 2), P), 'strong');
});
test('classify: both windows down + breadth + negative efficiency → weak', () => {
  assert.equal(classify(win('weakening', -0.6, 1, 6), win('weakening', -0.5, 2, 5), P), 'weak');
});
test('classify: windows disagree → mixed', () => {
  assert.equal(classify(win('strengthening', 0.6, 6, 1), win('weakening', -0.4, 2, 5), P), 'mixed');
});
test('classify: strong direction but breadth below min → mixed (breadth, not votes)', () => {
  assert.equal(classify(win('strengthening', 0.6, 4, 1), win('strengthening', 0.5, 6, 1), P), 'mixed');
});
test('classify: a window unavailable → insufficient', () => {
  assert.equal(classify({ available: false }, win('strengthening', 0.6, 6, 1), P), 'insufficient');
});
test('classify: effDeadband gates — efficiency below the band → mixed', () => {
  const strict = validParams({ effDeadband: 0.5 });
  assert.equal(classify(win('strengthening', 0.2, 6, 1), win('strengthening', 0.2, 6, 1), strict), 'mixed');
  assert.equal(classify(win('strengthening', 0.6, 6, 1), win('strengthening', 0.6, 6, 1), strict), 'strong');
});

// ── §5 windows are continuous; only period position resets at the baseline ───────────────────
test('period position resets at the baseline while the fast window stays continuous across it', () => {
  const N = 300;
  const by = genM15((N - 1) * 4, EAT_DAY0);
  const built = buildIndices(by);
  // a cutoff only 30min into an EAT day → the 1h fast window must reach back into the previous day
  const someDay = dayStart(EAT_DAY0 + 200 * HOUR);
  const cutoff = someDay + 30 * 60 * 1000;
  const cc = currencyCondition(built, by, 'USD', cutoff, DAILY, P);
  assert.equal(cc.periodStartMs, someDay, 'period anchored at the EAT day open');
  assert.ok(Math.abs(cc.periodPct) < 0.5, 'period position is small ~30min in');
  assert.ok(cc.fast.available, 'fast window available');
  assert.ok(cc.fast.startMs < someDay, 'fast window reaches back ACROSS the day baseline (continuous)');
  assert.notEqual(cc.fast.M, 0, 'fast-window movement is measured on the continuous index, not reset');
});

// ── §5 a scheduled-closure gap inside a window is TOLERATED and flagged (index skips closures) ─
test('windowMetrics: a timeline gap inside the window is tolerated + flagged (not rejected)', () => {
  const by = genM15(60, EAT_DAY0);
  const built = buildIndices(by);
  const n = built.timeline.length;
  built.timeline[n - 3] += 3 * M15;                 // stretch one interval (simulate a weekend gap)
  const w = windowMetrics(built, null, 'USD', n - 1, 4, null, 0.005);
  assert.equal(w.available, true, 'window still available over a scheduled closure');
  assert.ok(w.spansGap, 'the gap is flagged for disclosure');
  assert.ok(w.gaps >= 1);
});

// a window with too little history is still unavailable
test('windowMetrics: not enough history → unavailable', () => {
  const by = genM15(60, EAT_DAY0);
  const built = buildIndices(by);
  const w = windowMetrics(built, null, 'USD', 2, 16, null, 0.005);   // only 3 obs, need 16
  assert.equal(w.available, false);
  assert.equal(w.reason, 'insufficient-history');
});

// ── §7 spread expansion ──────────────────────────────────────────────────────────────────────
test('spreadExpands: base rising vs quote falling widens for BUY, not for SELL', () => {
  const by = genData(300, EAT_DAY0).m15ByPair;
  const built = buildIndices(by);
  const cutoff = built.lastMs;
  // find a currency pair where base is strengthening and quote weakening in both windows
  const cond = conditionAll(built, by, cutoff, DAILY, P);
  const strong = CURRENCIES.find((c) => cond[c].classification === 'strong');
  const weak = CURRENCIES.find((c) => cond[c].classification === 'weak');
  assert.ok(strong && weak, 'need a strong and a weak currency');
  const buy = spreadExpands(built, strong, weak, cutoff, DAILY, 'BUY', P);
  const sell = spreadExpands(built, strong, weak, cutoff, DAILY, 'SELL', P);
  assert.equal(buy.expanding, true, strong + '/' + weak + ' spread widens for BUY');
  assert.equal(sell.expanding, false, 'the same spread does not widen for SELL');
});

// ── recent condition, NOT persistent old state ───────────────────────────────────────────────
test('classification depends ONLY on the recent window, not on distant past prices', () => {
  const N = 700;
  const DATA = genData(N, EAT_DAY0);
  const LAST = EAT_DAY0 + (N - 1) * HOUR;
  const base = conditionAll(buildIndices(DATA.m15ByPair), DATA.m15ByPair, LAST, DAILY, P);

  // perturb ONLY the first 40% of every pair's M15 (far before any window/period read at LAST)
  const alt = cloneData(DATA);
  const cut = Math.floor(N * 0.4) * 4;            // M15 index ~40% through
  for (const p of Object.keys(alt.m15ByPair)) {
    alt.m15ByPair[p].forEach((r, i) => { if (i < cut) { r.open *= 1.05; r.high *= 1.05; r.low *= 1.05; r.close *= 1.05; } });
  }
  const perturbed = conditionAll(buildIndices(alt.m15ByPair), alt.m15ByPair, LAST, DAILY, P);

  for (const c of CURRENCIES) {
    assert.equal(perturbed[c].classification, base[c].classification,
      c + ' classification unchanged by distant-past prices (recent condition, not old state)');
  }
});
