'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { runBlocks, levelsFor, unitsOf } = require('../../research/flow/blocks');
const { simulatedEURUSD, closeObs } = require('../../research/flow/observations');
const { instrumentFor } = require('../../research/flow/config');

test('A–D reference sequence reproduces exact levels, widths and reversal timing', () => {
  const sim = simulatedEURUSD();
  const r = runBlocks(sim.observations, { anchor: sim.anchor, step: sim.step, precision: sim.precision });
  assert.ok(r.ok);
  assert.strictEqual(r.events.length, 3, 'A, B, C confirmed (D still forming)');

  // A — opening green block, 1.0830 → 1.0835, width 20
  const A = r.events[0];
  assert.strictEqual(A.activity, 20);
  assert.strictEqual(A.levels.length, 1);
  assert.strictEqual(A.levels[0].dir, 'up');
  assert.strictEqual(A.levels[0].open, 1.0830);
  assert.strictEqual(A.levels[0].close, 1.0835);

  // B — up continuation, 1.0835 → 1.0840, width 80 (exactly 4× A)
  const B = r.events[1];
  assert.strictEqual(B.activity, 80);
  assert.strictEqual(B.activity, 4 * A.activity);
  assert.strictEqual(B.levels[0].dir, 'up');
  assert.strictEqual(B.levels[0].close, 1.0840);

  // C — down reversal, red body 1.0835 → 1.0830, width 55; trace retains the 1.0843 peak
  const C = r.events[2];
  assert.strictEqual(C.activity, 55);
  assert.strictEqual(C.levels[0].dir, 'down');
  assert.strictEqual(C.levels[0].kind, 'reversal');
  assert.strictEqual(C.levels[0].open, 1.0835);
  assert.strictEqual(C.levels[0].close, 1.0830);
  assert.strictEqual(C.observedTrigger, 1.0830);
  assert.strictEqual(C.obsHigh, 1.0843, 'earlier peak retained in the trace');

  // D — forming, 1.0830 → 1.0827, width 20; a move to 1.0825 would confirm the next down continuation
  assert.ok(r.forming);
  assert.strictEqual(r.forming.activity, 20);
  assert.strictEqual(r.forming.dir, 'down');
  assert.strictEqual(r.forming.latest.value, 1.0827);
  assert.strictEqual(r.forming.nextDown, 1.0825);
});

test('up reversal mirrors down reversal (symmetric geometry)', () => {
  // anchor 100, step 1. Establish DOWN, then an up reversal at +2 steps.
  const obs = [
    { value: 100, ms: 0 },   // anchor seed
    { value: 99, ms: 1 },    // opening DOWN  → body [100,99], unit -1
    { value: 98, ms: 2 },    // down continuation → body [99,98], unit -2
    { value: 100, ms: 3 },   // UP reversal (≥ unit 0) → body [99,100], units [-1,0]
  ];
  const r = runBlocks(obs, { step: 1, precision: 6 });
  const rev = r.events[r.events.length - 1].levels[0];
  assert.strictEqual(rev.dir, 'up');
  assert.strictEqual(rev.kind, 'reversal');
  assert.strictEqual(rev.openUnit, -1);
  assert.strictEqual(rev.closeUnit, 0);
  assert.strictEqual(rev.open, 99);
  assert.strictEqual(rev.close, 100);

  // mirror: a DOWN reversal from UP has body [Cu-1, Cu-2]; UP reversal from DOWN has body [Cu+1, Cu+2].
  const { bodies } = levelsFor(/* +2 units */ 2, 0, 'down');
  assert.strictEqual(bodies[0].openUnit, 1);
  assert.strictEqual(bodies[0].closeUnit, 2);
  const down = levelsFor(-2, 0, 'up');
  assert.strictEqual(down.bodies[0].openUnit, -1);
  assert.strictEqual(down.bodies[0].closeUnit, -2);
});

test('one multi-level jump counts one activity unit and stores ordered levels', () => {
  const obs = [
    { value: 100, ms: 0 },   // anchor seed
    { value: 101, ms: 1 },   // opening UP → unit 1
    { value: 104, ms: 2 },   // single update crossing units 2,3,4 → one event, 3 levels
  ];
  const r = runBlocks(obs, { step: 1, precision: 6 });
  const jump = r.events[r.events.length - 1];
  assert.strictEqual(jump.activity, 1, 'the jump is one observation → one activity unit');
  assert.strictEqual(jump.levels.length, 3);
  assert.deepStrictEqual(jump.levels.map((l) => l.closeUnit), [2, 3, 4]);
  assert.strictEqual(jump.flags.multiJump, true);
  // flattened blocks: the group's activity is counted once (first level), others 0.
  const groupBlocks = r.blocks.filter((b) => b.eventId === jump.eventId);
  assert.strictEqual(groupBlocks[0].activity, 1);
  assert.strictEqual(groupBlocks[1].activity, 0);
  assert.strictEqual(groupBlocks[2].activity, 0);
});

test('pip precision: EUR/USD 5-pip step = 0.00050, USD/JPY 5-pip step = 0.050', () => {
  assert.strictEqual(instrumentFor('EUR_USD').step, 0.0005);
  assert.strictEqual(instrumentFor('EUR_USD').pip, 0.0001);
  assert.strictEqual(instrumentFor('USD_JPY').step, 0.05);
  assert.strictEqual(instrumentFor('USD_JPY').pip, 0.01);
});

test('a bid/ask change with unchanged midpoint still adds one activity unit (trace stays level)', () => {
  const obs = [
    { value: 1.0838, ms: 0, bid: 1.08376, ask: 1.08384 },   // anchor seed
    { value: 1.0838, ms: 1, bid: 1.08375, ask: 1.08385 },   // same midpoint, shifted quote
    { value: 1.0838, ms: 2, bid: 1.08374, ask: 1.08386 },   // same midpoint again
    { value: 1.0838, ms: 3, bid: 1.08373, ask: 1.08387 },
  ];
  const r = runBlocks(obs, { anchor: 1.0838, step: 0.0005, precision: 5 });
  assert.strictEqual(r.events.length, 0, 'no block confirms on a flat midpoint');
  assert.strictEqual(r.forming.activity, 3, 'each eligible update widens activity');
  assert.strictEqual(r.forming.obsHigh, r.forming.obsLow, 'the trace stays level');
});

test('determinism / no look-ahead: a prefix reproduces the same confirmed blocks', () => {
  const sim = simulatedEURUSD();
  const full = runBlocks(sim.observations, { anchor: sim.anchor, step: sim.step, precision: sim.precision });
  // feed only through the middle of C (before its 55th update): A and B identical, C not yet confirmed.
  const prefixLen = sim.observations.length - 30;
  const prefix = runBlocks(sim.observations.slice(0, prefixLen), { anchor: sim.anchor, step: sim.step, precision: sim.precision });
  assert.strictEqual(prefix.events.length, 2, 'only A and B confirmed in the prefix');
  assert.deepStrictEqual(
    prefix.events.map((e) => [e.activity, e.levels[0].open, e.levels[0].close]),
    full.events.slice(0, 2).map((e) => [e.activity, e.levels[0].open, e.levels[0].close]),
  );
});

test('activity accounting conserves observations (close-only invents nothing)', () => {
  const sim = simulatedEURUSD();
  const r = runBlocks(sim.observations, { anchor: sim.anchor, step: sim.step, precision: sim.precision });
  const counted = sim.observations.length - 1;   // anchor seed excluded
  const sum = r.events.reduce((a, e) => a + e.activity, 0) + (r.forming ? r.forming.activity : 0);
  assert.strictEqual(sum, counted);
});

test('closeObs yields exactly one observation per completed candle (no intrabar path)', () => {
  const candles = [
    { openMs: 0, close: 1.1000 }, { openMs: 300000, close: 1.1002 }, { openMs: 600000, close: 1.1001 },
  ];
  const obs = closeObs(candles, 300000, 'M5');
  assert.strictEqual(obs.length, candles.length);
  assert.strictEqual(obs[0].ms, 300000);   // completion = openMs + resMs
  assert.strictEqual(obs[1].value, 1.1002);
});

test('insufficient / flat input is handled without fabricating blocks', () => {
  assert.strictEqual(runBlocks([]).ok, false);
  const flat = runBlocks([{ value: 1.1, ms: 0 }, { value: 1.10005, ms: 1 }, { value: 1.10002, ms: 2 }], { anchor: 1.1, step: 0.0005, precision: 5 });
  assert.strictEqual(flat.events.length, 0);
  assert.strictEqual(flat.forming.activity, 2);   // 2 updates after the seed, none crossing a full step
});

test('unitsOf treats an exact threshold as a crossing despite float noise', () => {
  // (1.0835 − 1.0830)/0.0005 should be exactly 1, not 0.9999999999.
  assert.strictEqual(unitsOf(1.0835, 1.0830, 0.0005), 1);
});
