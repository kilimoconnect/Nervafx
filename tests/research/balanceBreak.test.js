'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detect, patternSeries, PATTERN_VERSION } = require('../../research/m15/balanceBreak');

const M15 = require('../../research/m15/timeframe').INTERVAL_MS;
const START = Date.UTC(2026, 0, 5, 0, 0, 0);   // a Monday, well clear of weekends

// Build contiguous M15 candles from a close series (open = previous close; no wicks).
function mk(closes, startMs) {
  return closes.map((cl, i) => { const o = i === 0 ? cl : closes[i - 1]; return { openMs: (startMs || START) + i * M15, open: o, high: Math.max(o, cl), low: Math.min(o, cl), close: cl, complete: true, source: 'OANDA' }; });
}
const closeMs = (c) => c.openMs + M15;
// A balance band: closes alternate 100.00 / 100.03 so median|Δ| = 0.03 ⇒ tol = 0.03, zone [99.97, 100.03].
const BAL = [100.00, 100.03, 100.00, 100.03, 100.00, 100.03, 100.00, 100.03, 100.00, 100.03, 100.00, 100.03];

// Replay helper: detect at EVERY eligible close, return compact states.
function replay(cands) {
  return patternSeries(cands, {}).map((p) => ({ t: p.asOfCloseMs, state: p.state, knowable: p.knowableAtMs, confMs: p.confirmation ? p.confirmation.ms : null, dir: p.direction }));
}

test('module is versioned and deterministic', () => {
  assert.equal(PATTERN_VERSION, 'accepted-balance-break-1.0.0');
  const cands = mk(BAL.concat([100.40, 100.43]));
  const a = detect(cands, { asOfCloseMs: closeMs(cands[cands.length - 1]) });
  const b = detect(cands, { asOfCloseMs: closeMs(cands[cands.length - 1]) });
  assert.deepEqual(a, b);
});

test('A — genuine accepted break: CONFIRMED only at the acceptance candle, never earlier', () => {
  const cands = mk(BAL.concat([100.40, 100.43]));            // provisional, then accepted (2 consecutive beyond)
  const provT = closeMs(cands[12]), accT = closeMs(cands[13]);
  const seq = replay(cands);
  // no CONFIRMED appears before the acceptance close
  for (const s of seq) { if (s.t < accT) assert.notEqual(s.state, 'CONFIRMED', `early CONFIRMED at ${new Date(s.t).toISOString()}`); assert.ok(s.knowable <= s.t, 'no future-stamped knowable'); if (s.confMs != null) assert.ok(s.confMs <= s.t, 'no future confirmation ms'); }
  const atProv = detect(cands, { asOfCloseMs: provT });
  assert.equal(atProv.state, 'FORMING'); assert.equal(atProv.direction, 'UP'); assert.equal(atProv.knowableAtMs, provT);
  const atAcc = detect(cands, { asOfCloseMs: accT });
  assert.equal(atAcc.state, 'CONFIRMED'); assert.equal(atAcc.confirmation.ms, accT); assert.equal(atAcc.confirmation.kind, 'consecutive');
  assert.equal(atAcc.confirmation.price, 100.43); assert.equal(atAcc.knowableAtMs, accT);
  assert.equal(atAcc.invalidation.price, 100.03, 'invalidation reference = breached upper edge, anchored at the provisional close');
});

test('B — break still forming: provisional only ⇒ FORMING (not CONFIRMED)', () => {
  const cands = mk(BAL.concat([100.40]));
  const p = detect(cands, { asOfCloseMs: closeMs(cands[cands.length - 1]) });
  assert.equal(p.state, 'FORMING'); assert.equal(p.direction, 'UP');
  assert.equal(p.confirmation, null);
  assert.equal(p.departure.provisionalMs, closeMs(cands[12]));
});

test('C — immediate re-entry before acceptance ⇒ INVALIDATED', () => {
  const cands = mk(BAL.concat([100.40, 99.98]));            // close back inside, deeper than tol from the edge
  const seq = replay(cands);
  assert.equal(seq[12].state, 'FORMING');                    // the provisional close
  const last = detect(cands, { asOfCloseMs: closeMs(cands[13]) });
  assert.equal(last.state, 'INVALIDATED');
  assert.equal(last.knowableAtMs, closeMs(cands[13]));
  assert.match(last.invalidation.how, /returned into balance/);
});

test('D — missing candle: acceptance is NOT confirmed across a gap; FORMING, gap stays visible', () => {
  const full = mk(BAL.concat([100.40, 100.42, 100.43]));
  const cands = full.slice(0, 13).concat(full.slice(14));    // drop index 13 (the 100.42 candle) → a one-candle gap
  const accT = closeMs(full[14]);                            // the two beyond closes (idx12, idx14) are NOT contiguous
  const p = detect(cands, { asOfCloseMs: accT });
  assert.equal(p.state, 'FORMING');                          // confirmation withheld — no contiguous acceptance
  assert.equal(p.confirmation, null);
  assert.equal(p.confirmationPending, 'DATA_GAP');
  assert.ok(p.dataHealth.gaps.length >= 1, 'the gap is reported, not hidden');
  assert.equal(p.dataHealth.staleBeforeClose, true);
  for (const s of replay(cands)) { assert.ok(s.knowable <= s.t); assert.notEqual(s.state, 'CONFIRMED'); assert.notEqual(s.knowable, closeMs(full[13])); }
});

test('D2 — a contiguous hold AFTER the gap does confirm (recovery), stamped on a real candle', () => {
  const full = mk(BAL.concat([100.40, 100.42, 100.43, 100.45]));
  const cands = full.slice(0, 13).concat(full.slice(14));    // gap at idx13; idx14=100.43, idx15=100.45 are contiguous & beyond
  const p = detect(cands, { asOfCloseMs: closeMs(full[15]) });
  assert.equal(p.state, 'CONFIRMED');
  assert.equal(p.confirmation.ms, closeMs(full[15]));        // first contiguous pair ends at idx15
});

test('E — confirmation delay via held retest: FORMING through the retest, CONFIRMED (retest) only on the re-break', () => {
  const cands = mk(BAL.concat([100.40, 100.02, 100.45]));    // provisional, retest inside near edge, close beyond again
  const provT = closeMs(cands[12]), retestT = closeMs(cands[13]), reBreakT = closeMs(cands[14]);
  assert.equal(detect(cands, { asOfCloseMs: provT }).state, 'FORMING');
  assert.equal(detect(cands, { asOfCloseMs: retestT }).state, 'FORMING');   // retest does NOT confirm
  const done = detect(cands, { asOfCloseMs: reBreakT });
  assert.equal(done.state, 'CONFIRMED');
  assert.equal(done.confirmation.kind, 'retest');
  assert.equal(done.confirmation.ms, reBreakT);
  for (const s of replay(cands)) { if (s.t < reBreakT) assert.notEqual(s.state, 'CONFIRMED'); }
});

test('downward accepted break works symmetrically', () => {
  const cands = mk(BAL.concat([99.60, 99.57]));
  const p = detect(cands, { asOfCloseMs: closeMs(cands[cands.length - 1]) });
  assert.equal(p.state, 'CONFIRMED'); assert.equal(p.direction, 'DOWN');
  assert.equal(p.invalidation.price, 99.97);   // breached lower edge, anchored at the provisional close
  assert.ok(p.swingContext && 'supportsBreak' in p.swingContext);   // (#4) descriptive swing context present
});

test('#1 — a single close back inside does NOT invalidate a CONFIRMED break; two consecutive do', () => {
  const one = mk(BAL.concat([100.40, 100.43, 100.00]));              // confirm, then ONE close back inside
  assert.equal(detect(one, { asOfCloseMs: closeMs(one[one.length - 1]) }).state, 'CONFIRMED');
  const two = mk(BAL.concat([100.40, 100.43, 100.00, 100.00]));      // two consecutive closes back inside
  const p = detect(two, { asOfCloseMs: closeMs(two[two.length - 1]) });
  assert.equal(p.state, 'INVALIDATED'); assert.match(p.invalidation.how, /reclaimed/);
});

test('#6 — a prior resolved episode is listed in recentEpisodes', () => {
  // break up (confirm), reclaim (2 inside), then break down (confirm) → the up episode is "recent"
  const cands = mk(BAL.concat([100.40, 100.43, 100.00, 100.00, 99.60, 99.57]));
  const p = detect(cands, { asOfCloseMs: closeMs(cands[cands.length - 1]) });
  assert.equal(p.direction, 'DOWN');
  assert.ok(p.recentEpisodes.length >= 1 && p.recentEpisodes.some((e) => e.direction === 'UP'));
});

test('price context (12/24/36/48h) and strength are separate fields; disagreement stays visible', () => {
  const cands = mk(BAL.concat([100.40, 100.43]));
  const T = closeMs(cands[cands.length - 1]);
  // break is UP; a network whose 24h gap is negative (quote stronger) must DISAGREE and be shown
  const net = { windows: { h24: { available: true } }, leaveOnePairOut: { confirmations: { EUR_USD: { full: { baseMinusQuote: -0.002 }, independentlyConfirmed: true } } } };
  const p = detect(cands, { pair: 'EUR_USD', network: net, asOfCloseMs: T });
  assert.ok(p.priceContext && 'h12' in p.priceContext && 'h48' in p.priceContext);
  assert.equal(p.strength.available, true);
  assert.equal(p.strength.agrees, false);
  assert.match(p.strength.disagreement, /favours the quote currency/);   // not silently discarded
});

test('no balance / insufficient data ⇒ UNAVAILABLE with a reason', () => {
  assert.equal(detect(mk([100, 100, 100]), { asOfCloseMs: START + 5 * M15 }).state, 'UNAVAILABLE');  // flat ⇒ no zone
  assert.equal(detect([], { asOfCloseMs: START }).state, 'UNAVAILABLE');
});

const study = require('../../research/m15/balanceBreak_outcome_prereg');

test('outcome study is frozen, with 4 & 16 horizons and economics/probability withheld', () => {
  assert.deepEqual(study.SPEC.horizonsCandles, [4, 16]);
  assert.equal(study.SPEC_HASH.length, 64);
  const r = study.report({}, 4);
  assert.match(r.predictiveProbability, /UNAVAILABLE/);
  assert.match(r.economics, /UNAVAILABLE/);
  assert.match(r.status, /PENDING/);
});

test('outcome measurement is causal: unresolved until forward candles exist; no probability emitted', () => {
  const cands = mk(BAL.concat([100.40, 100.43, 100.50, 100.55, 100.60, 100.63, 100.66]));   // confirm at idx13, then 5 more
  const confirmMs = closeMs(cands[13]);
  assert.equal(study.continuationAt(cands, confirmMs, 'UP', 16).resolved, false);  // 16 forward candles don't exist yet
  const r4 = study.continuationAt(cands, confirmMs, 'UP', 4);
  assert.equal(r4.resolved, true); assert.equal(r4.continued, true);
  const g = study.scoreGroup([{ pair: 'X', confirmMs, direction: 'UP' }], { X: cands }, 4);
  assert.equal(g.resolved, 1); assert.equal(g.continued, 1);
  assert.ok(!('probability' in g) && /NOT a calibrated probability/.test(g.note));
});
