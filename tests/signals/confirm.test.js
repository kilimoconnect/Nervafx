'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildIndices } = require('../../research/comparison/index-build');
const { evaluateCandidate, breadth } = require('../../research/signals/confirm');
const { latestCompletedInterval, causalCut } = require('../../research/signals/evaluate');
const { strategyDef, TF_MS } = require('../../research/signals/config');
const { genBase, scaledGrowth, CURRENCIES } = require('./fixtures');

const M15 = TF_MS.M15, H1 = TF_MS.H1;
const params = strategyDef('today').params;
const START = Date.UTC(2025, 4, 1, 0, 0, 0);

test('latestCompletedInterval never includes a forming candle', () => {
  const mid = START + 25 * H1 + 20 * 60 * 1000;             // 20 min into an hour
  const i1 = latestCompletedInterval(H1, mid);
  assert.equal(i1.endMs, START + 25 * H1, 'ends at the last completed hour');
  assert.equal(i1.startMs, START + 24 * H1);
  const onBoundary = START + 25 * H1;
  const i2 = latestCompletedInterval(H1, onBoundary);
  assert.equal(i2.endMs, onBoundary, 'exact boundary → that candle is complete');
  assert.equal(i2.startMs, START + 24 * H1);
});

test('BUY confirmation passes when A rises (≥5/7) and B falls (≥5/7) over the candle', () => {
  const n = 101;                                            // 25h of M15 + 1
  const by = genBase(scaledGrowth(0.0003), START, n, M15);
  const asOf = START + 25 * H1;
  const cut = causalCut(by, M15, asOf);
  const built = buildIndices(cut, { baseMs: M15 });
  const conf = latestCompletedInterval(H1, asOf);
  const cand = { pair: 'AUD_JPY', a: 'AUD', b: 'JPY', bias: 'BUY', differential: 1 };
  const res = evaluateCandidate(cand, built, cut, M15, conf, params);
  assert.ok(res.pass, 'confirmation passes: ' + res.reasons.join(', '));
  assert.ok(res.readings.A.ret > 0 && res.readings.B.ret < 0);
  assert.ok(res.breadth.A.up >= params.breadthMin, 'A breadth meets threshold');
  assert.ok(res.breadth.B.down >= params.breadthMin, 'B breadth meets threshold');
});

test('wrong-direction (SELL on a rising A) fails with a reason; zero never supports', () => {
  const n = 101;
  const by = genBase(scaledGrowth(0.0003), START, n, M15);
  const asOf = START + 25 * H1;
  const cut = causalCut(by, M15, asOf);
  const built = buildIndices(cut, { baseMs: M15 });
  const conf = latestCompletedInterval(H1, asOf);
  const cand = { pair: 'AUD_JPY', a: 'AUD', b: 'JPY', bias: 'SELL', differential: -1 };
  const res = evaluateCandidate(cand, built, cut, M15, conf, params);
  assert.equal(res.pass, false);
  assert.ok(res.reasons.length > 0);
});

test('breadth counts the 7 oriented legs (participation, not 7 confirmations)', () => {
  const n = 101;
  const by = genBase(scaledGrowth(0.0003), START, n, M15);
  const cut = causalCut(by, M15, START + 25 * H1);
  const br = breadth('AUD', cut, START + 24 * H1, START + 25 * H1, M15, params.unchangedPairLogret);
  assert.equal(br.valid, 7);
  assert.equal(br.up + br.down + br.flat, 7);
  assert.equal(br.up, 7, 'AUD rises against all counterparts in this monotone fixture');
});
