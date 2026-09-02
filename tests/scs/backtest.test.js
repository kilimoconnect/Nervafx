'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { backtestPair, runBacktest } = require('../../api/_scs-backtest');

const H1 = 3600000;
function week(startMs, hours) { const a = []; for (let i = 0; i < hours; i++) a.push({ openMs: startMs + i * H1, open: 1.10, high: 1.1010, low: 1.099, close: 1.10 }); return a; }
const START = Date.UTC(2026, 6, 19, 21, 0);
const h1raw = week(START, 120);

test('backtest runs over the production coordinator and returns no signals on structureless data', () => {
  const s = backtestPair(h1raw, { pair: 'EUR_USD', from: START, to: START + 119 * H1 });
  assert.ok(Array.isArray(s));
  assert.equal(s.length, 0);          // flat data forms no valid setup — never fabricated
});

test('sequential in-sample / out-of-sample; overlap is rejected (no future/past mixing)', () => {
  const pairs = { EUR_USD: h1raw };
  const r = runBacktest({ pairs, inSample: { from: START, to: START + 60 * H1 }, outSample: { from: START + 60 * H1, to: START + 119 * H1 } });
  assert.ok(r.inSample && r.outSample);
  assert.equal(r.config, 'scs_v1');
  assert.throws(() => runBacktest({ pairs, inSample: { from: START, to: START + 60 * H1 }, outSample: { from: START + 30 * H1, to: START + 90 * H1 } }), /no future\/past mixing/);
});

test('deterministic: identical inputs reproduce identical results', () => {
  const inp = { pairs: { EUR_USD: h1raw }, inSample: { from: START, to: START + 119 * H1 } };
  assert.deepEqual(JSON.parse(JSON.stringify(runBacktest(inp))), JSON.parse(JSON.stringify(runBacktest(inp))));
});

test('performance object is present and honest (0 trades ⇒ 0 stats, no inference)', () => {
  const r = runBacktest({ pairs: { EUR_USD: h1raw }, inSample: { from: START, to: START + 119 * H1 } });
  assert.equal(r.inSample.performance.totalTrades, 0);
  assert.equal(r.inSample.performance.avgR, 0);
});
