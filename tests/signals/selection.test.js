'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildIndices } = require('../../research/comparison/index-build');
const { currencyReturns, rankPairs, topN } = require('../../research/signals/selection');
const { strategyDef } = require('../../research/signals/config');
const { genBase, scaledGrowth, CURRENCIES, TF_MS } = require('./fixtures');

const M15 = TF_MS.M15;
const START = Date.UTC(2025, 4, 1, 0, 0, 0);

function builtFull(k = 0.0003, n = 200) {
  const by = genBase(scaledGrowth(k), START, n, M15);
  const built = buildIndices(by, { baseMs: M15 });
  assert.ok(built.ok, 'index built');
  return built;
}

test('differential = rA − rB and drives BUY/SELL bias', () => {
  const built = builtFull();
  const r = currencyReturns(built, CURRENCIES, built.firstMs, built.lastMs);
  // AUD has the highest growth, JPY the lowest → AUD return > JPY return.
  assert.ok(r.AUD > r.JPY, 'AUD outperforms JPY');
  const ranked = rankPairs(r);
  const audjpy = ranked.find((x) => x.pair === 'AUD_JPY');
  assert.equal(audjpy.a, 'AUD'); assert.equal(audjpy.b, 'JPY');
  assert.ok(Math.abs(audjpy.differential - (r.AUD - r.JPY)) < 1e-12, 'differential = rA − rB');
  assert.equal(audjpy.bias, 'BUY', 'positive differential → BUY');
});

test('top pair is the widest growth gap (AUD vs JPY); 28 pairs each ranked once', () => {
  const built = builtFull();
  const r = currencyReturns(built, CURRENCIES, built.firstMs, built.lastMs);
  const ranked = rankPairs(r);
  assert.equal(ranked.length, 28);
  const symbols = new Set(ranked.map((x) => x.pair));
  assert.equal(symbols.size, 28, 'every economic pair appears exactly once');
  assert.equal(ranked[0].pair, 'AUD_JPY', 'rank 1 = widest differential');
  // ranks are contiguous 1..28
  ranked.forEach((x, i) => assert.equal(x.rank, i + 1));
});

test('exact ties resolve deterministically by pair symbol (asc)', () => {
  const built = builtFull();
  const r = currencyReturns(built, CURRENCIES, built.firstMs, built.lastMs);
  const ranked = rankPairs(r);
  // AUD−NZD gap = 5 units, GBP−JPY gap = 5 units → equal |differential|.
  const an = ranked.find((x) => x.pair === 'AUD_NZD');
  const gj = ranked.find((x) => x.pair === 'GBP_JPY');
  assert.ok(Math.abs(an.absDiff - gj.absDiff) < 1e-12, 'AUD_NZD and GBP_JPY tie on |differential|');
  assert.ok(an.rank < gj.rank, "'AUD_NZD' sorts before 'GBP_JPY'");
  // and they are adjacent in the ranking (nothing injected between a true tie)
  assert.equal(gj.rank, an.rank + 1);
});

test('topN takes ranks 1..N strictly — never substitutes a lower-ranked pair', () => {
  const built = builtFull();
  const r = currencyReturns(built, CURRENCIES, built.firstMs, built.lastMs);
  const ranked = rankPairs(r);
  const top3 = topN(ranked, 3);
  assert.deepEqual(top3.map((x) => x.rank), [1, 2, 3]);
  assert.equal(top3[0].pair, 'AUD_JPY');
});

test('strategy timeframe mapping matches the spec table', () => {
  const t = strategyDef('today'), w = strategyDef('week'), m = strategyDef('month');
  assert.deepEqual([t.confirmTf, t.entryTf], ['H1', 'M15']);
  assert.deepEqual([w.confirmTf, w.entryTf], ['H4', 'H1']);
  assert.deepEqual([m.confirmTf, m.entryTf], ['D1', 'H4']);
  // base resolution the entry TF is aggregated from
  assert.equal(t.entryBaseTf, 'M15');
  assert.equal(w.entryBaseTf, 'H1');
  assert.equal(m.entryBaseTf, 'H1');
  assert.equal(t.version, 'tsf-1.0.0');
});
