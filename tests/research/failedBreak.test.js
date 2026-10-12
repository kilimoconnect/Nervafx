'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fb = require('../../research/m15/failedBreak');
const ab = require('../../research/m15/balanceBreak');

const M15 = 15 * 60 * 1000;
const START = Date.UTC(2026, 0, 5, 0, 0, 0);
function mk(closes, startMs) { return closes.map((cl, i) => { const o = i === 0 ? cl : closes[i - 1]; return { openMs: (startMs || START) + i * M15, open: o, high: Math.max(o, cl), low: Math.min(o, cl), close: cl, complete: true, source: 'OANDA' }; }); }
const closeMs = (c) => c.openMs + M15;
const BAL = [100.00, 100.03, 100.00, 100.03, 100.00, 100.03, 100.00, 100.03, 100.00, 100.03, 100.00, 100.03];
const detect = (cands, T) => fb.detect(cands, { asOfCloseMs: T == null ? closeMs(cands[cands.length - 1]) : T });

test('versioned', () => { assert.equal(fb.PATTERN_VERSION, 'failed-balance-break-1.0.0'); });

test('genuine failed DEPARTURE (never accepted): 2 contiguous closes back inside ⇒ CONFIRMED, not backdated', () => {
  const cands = mk(BAL.concat([100.40, 99.98, 99.99]));          // provisional(idx12), inside(idx13), inside(idx14)
  const provT = closeMs(cands[12]), reclaimT = closeMs(cands[14]);
  const seq = fb.patternSeries(cands, {});
  for (const p of seq) { assert.ok(p.knowableAtMs <= p.asOfCloseMs); if (p.asOfCloseMs < reclaimT) assert.notEqual(p.state, 'CONFIRMED'); }  // never early
  const p = detect(cands);
  assert.equal(p.state, 'CONFIRMED'); assert.equal(p.direction, 'UP');
  assert.equal(p.confirmation.ms, reclaimT);                      // reclaim candle, NOT the departure (idx12)
  assert.notEqual(p.confirmation.ms, provT);
  assert.equal(p.confirmation.failureType, 'departure-rejected');
});

test('quick single re-entry is a routine retest ⇒ FORMING, not CONFIRMED', () => {
  const cands = mk(BAL.concat([100.40, 99.98]));                  // one close back inside only
  const p = detect(cands);
  assert.equal(p.state, 'FORMING'); assert.equal(p.confirmation, null);
});

test('genuine failed ACCEPTANCE: accepted break reclaimed ⇒ CONFIRMED with transition; not contradictory', () => {
  const cands = mk(BAL.concat([100.40, 100.43, 100.00, 100.00]));  // accept(idx13), inside(idx14,15)
  const T = closeMs(cands[cands.length - 1]);
  const p = detect(cands, T), a = ab.detect(cands, { asOfCloseMs: T });
  assert.equal(p.state, 'CONFIRMED'); assert.equal(p.confirmation.failureType, 'acceptance-reclaimed');
  assert.equal(p.transition.from, 'ACCEPTED_BREAK_CONFIRMED');
  assert.equal(a.state, 'INVALIDATED');                           // accepted-break agrees it was reclaimed
  assert.ok(!(a.state === 'CONFIRMED' && p.state === 'CONFIRMED'), 'never both succeeding/contradictory');
});

test('successful retest + continuation ⇒ accepted CONFIRMED, failed NOT confirmed (no contradiction)', () => {
  const cands = mk(BAL.concat([100.40, 100.02, 100.45]));         // provisional, retest, re-break accepted
  const T = closeMs(cands[cands.length - 1]);
  const a = ab.detect(cands, { asOfCloseMs: T }), p = detect(cands, T);
  assert.equal(a.state, 'CONFIRMED');
  assert.notEqual(p.state, 'CONFIRMED');                          // no failure confirmed
});

test('ambiguous wick-only penetration never starts an attempt ⇒ UNAVAILABLE', () => {
  const candsBase = mk(BAL);
  const last = candsBase[candsBase.length - 1];
  const wick = { openMs: last.openMs + M15, open: 100.00, high: 100.20, low: 99.99, close: 100.02, complete: true, source: 'OANDA' };  // wick above, close inside
  const cands = candsBase.concat([wick]);
  const p = fb.detect(cands, { asOfCloseMs: closeMs(wick) });
  assert.equal(p.state, 'UNAVAILABLE'); assert.equal(p.reason, 'NO_ATTEMPT');
});

test('gap inside the reclaim ⇒ not confirmed (FORMING), gap stays visible', () => {
  const full = mk(BAL.concat([100.40, 99.98, 99.985, 99.99]));    // inside at idx13, idx14, idx15
  const cands = full.slice(0, 14).concat(full.slice(15));         // drop idx14 → inside closes idx13 & idx15 non-contiguous
  const p = detect(cands);
  assert.equal(p.state, 'FORMING');
  assert.ok(p.dataHealth.gaps.length >= 1);
});

test('missing / no balance ⇒ UNAVAILABLE', () => {
  assert.equal(fb.detect(mk([100, 100, 100]), { asOfCloseMs: START + 5 * M15 }).state, 'UNAVAILABLE');
  assert.equal(fb.detect([], { asOfCloseMs: START }).state, 'UNAVAILABLE');
});

test('failed-break outcome study is frozen (4 & 16), overlap-aware, probability/economics withheld', () => {
  const study = require('../../research/m15/failedBreak_outcome_prereg');
  assert.deepEqual(study.SPEC.horizonsCandles, [4, 16]);
  assert.equal(study.SPEC_HASH.length, 64);
  assert.match(study.SPEC.overlapHandling, /ISO week/);
  assert.ok(study.SPEC.comparisonGroups.some((g) => /accepted-transition/.test(g)));
  const r = study.report({}, 16);
  assert.match(r.predictiveProbability, /UNAVAILABLE/);
  assert.match(r.economics, /UNAVAILABLE/);
  assert.match(r.improvement, /UNAVAILABLE/);
});

test('downward failed break is symmetric; price context + strength carried', () => {
  const cands = mk(BAL.concat([99.60, 99.57, 100.00, 100.00]));   // down accept then reclaim
  const net = { windows: { h24: { available: true } }, leaveOnePairOut: { confirmations: { EUR_USD: { full: { baseMinusQuote: 0.002 }, independentlyConfirmed: true } } } };
  const p = fb.detect(cands, { pair: 'EUR_USD', network: net, asOfCloseMs: closeMs(cands[cands.length - 1]) });
  assert.equal(p.state, 'CONFIRMED'); assert.equal(p.direction, 'DOWN');
  assert.ok('h48' in p.priceContext); assert.equal(p.strength.available, true);
});
