'use strict';

const test = require('node:test');
const assert = require('node:assert');
const pb = require('../../research/m15/pullback');

const M15 = 15 * 60 * 1000;
const START = Date.UTC(2026, 0, 5, 0, 0, 0);
function mk(closes, startMs) { return closes.map((cl, i) => { const o = i === 0 ? cl : closes[i - 1]; return { openMs: (startMs || START) + i * M15, open: o, high: Math.max(o, cl), low: Math.min(o, cl), close: cl, complete: true, source: 'OANDA' }; }); }
const closeMs = (c) => c.openMs + M15;
const SCALE = []; for (let i = 0; i < 20; i++) SCALE.push(i % 2 ? 100.1 : 100.0);
const IMP_UP = [99.7, 99.5, 99.9, 100.4, 100.9, 101.4];            // confirmed up leg: low 99.5 → high 101.4
const up = (tail) => SCALE.concat(IMP_UP, tail);
const detect = (cands, T) => pb.detect(cands, { asOfCloseMs: T == null ? closeMs(cands[cands.length - 1]) : T });

test('versioned', () => { assert.equal(pb.PATTERN_VERSION, 'trend-pullback-continuation-1.0.0'); });

test('shallow pullback + resumption ⇒ CONFIRMED only at the 2-close resumption, not backdated', () => {
  const cands = mk(up([101.0, 100.7, 100.6, 101.6, 101.9]));       // pullback holds, then 2 closes beyond 101.4
  const contT = closeMs(cands[30]);
  for (const p of pb.patternSeries(cands, {})) { assert.ok(p.knowableAtMs <= p.asOfCloseMs); if (p.asOfCloseMs < contT) assert.notEqual(p.state, 'CONFIRMED'); }
  const p = detect(cands);
  assert.equal(p.state, 'CONFIRMED'); assert.equal(p.direction, 'UP');
  assert.equal(p.confirmation.ms, contT);                          // the resumption candle, not the pullback low or impulse
  assert.ok(p.pullback.confirmed === false);                       // pullback extreme never labelled with later info
  assert.equal(p.invalidation.price, p.structure.structuralLevel.price);
});

test('normal pullback (no resumption yet) ⇒ FORMING, holds the structural level', () => {
  const p = detect(mk(up([101.0, 100.7, 100.6])));
  assert.equal(p.state, 'FORMING'); assert.equal(p.direction, 'UP');
  assert.equal(p.confirmation, null);
  assert.ok(p.evidenceFor.length >= 1);
});

test('deep pullback that breaks the structural level ⇒ INVALIDATED (broken trend)', () => {
  const p = detect(mk(up([101.0, 100.3, 99.8, 99.3])));            // closes below the higher-low base 99.5
  assert.equal(p.state, 'INVALIDATED');
  assert.match(p.invalidation.how, /structural level/);
});

test('prolonged sideways pause ⇒ FORMING + stalled (no forced continuation)', () => {
  const sideways = []; for (let i = 0; i < 18; i++) sideways.push(i % 2 ? 101.0 : 100.9);
  const p = detect(mk(up(sideways)));
  assert.equal(p.state, 'FORMING'); assert.equal(p.stalled, true);
});

test('one-candle false resumption does NOT confirm', () => {
  const p = detect(mk(up([101.0, 100.7, 101.6, 100.8])));          // single poke beyond, then back
  assert.notEqual(p.state, 'CONFIRMED');
});

test('gap in the resumption ⇒ not confirmed (FORMING), gap stays visible', () => {
  const full = mk(up([101.0, 100.7, 100.6, 101.6, 101.7, 101.9])); // resume would be idx29,30,31
  const cands = full.slice(0, 30).concat(full.slice(31));          // drop idx30 → the two closes beyond are non-contiguous
  const p = detect(cands);
  assert.equal(p.state, 'FORMING');
  assert.ok(p.dataHealth.gaps.length >= 1);
});

test('missing / no trend ⇒ UNAVAILABLE', () => {
  assert.equal(pb.detect(mk([100, 100, 100]), { asOfCloseMs: START + 5 * M15 }).state, 'UNAVAILABLE');
  assert.equal(pb.detect([], { asOfCloseMs: START }).state, 'UNAVAILABLE');
});

test('integrated outcome study: frozen, 3 detectors, embargo ≥ max horizon, forecast NOT enabled', () => {
  const S = require('../../research/m15/patterns_outcome_prereg');
  assert.deepEqual(S.SPEC.horizonsCandles, [4, 16]);
  assert.equal(S.SPEC_HASH.length, 64);
  assert.equal(Object.keys(S.SPEC.detectors).length, 3);
  assert.ok(S.SPEC.embargoCandles >= Math.max.apply(null, S.SPEC.horizonsCandles));
  assert.equal(S.decideDisplay(null).enabled, false);
  assert.equal(S.decideDisplay(null).verdict, 'NO_RELIABLE_FORECAST');
  const r = S.report({}, 16);
  assert.match(r.predictiveProbability, /UNAVAILABLE/); assert.match(r.economics, /UNAVAILABLE/);
});

test('integrated study helpers: non-overlapping dedup, Wilson interval, no probability', () => {
  const S = require('../../research/m15/patterns_outcome_prereg');
  const w = S.wilson95(6, 10); assert.ok(w.lo != null && w.hi >= w.lo && w.width > 0);
  const ins = [{ pair: 'X', confirmMs: 100 * M15, direction: 'UP' }, { pair: 'X', confirmMs: 102 * M15, direction: 'UP' }, { pair: 'X', confirmMs: 120 * M15, direction: 'UP' }];
  assert.equal(S.nonOverlapping(ins, 16).length, 2);   // second (within 16 candles) dropped
  const g = S.scoreGroup([], {}, 4); assert.ok(!('probability' in g) && /NOT a calibrated probability/.test(g.note));
});

test('downward pullback continuation is symmetric; context + strength carried', () => {
  const impDown = [100.3, 100.5, 100.1, 99.6, 99.1, 98.6];         // down leg: high 100.5 → low 98.6
  const cands = mk(SCALE.concat(impDown, [99.0, 99.3, 99.4, 98.4, 98.1]));  // pullback up holds below 100.5, then 2 closes below 98.6
  const net = { windows: { h24: { available: true } }, leaveOnePairOut: { confirmations: { EUR_USD: { full: { baseMinusQuote: -0.01 }, independentlyConfirmed: true } } } };
  const p = pb.detect(cands, { pair: 'EUR_USD', network: net, asOfCloseMs: closeMs(cands[cands.length - 1]) });
  assert.equal(p.state, 'CONFIRMED'); assert.equal(p.direction, 'DOWN');
  assert.ok('h48' in p.priceContext); assert.equal(p.strength.available, true);
});
