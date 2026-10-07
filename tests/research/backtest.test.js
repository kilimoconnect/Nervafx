'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { M15, simulateReference, forwardMovement } = require('../../research/m15/backtest');

const PIP = 0.0001, ATR = 0.0010;                 // 10-pip ATR ⇒ stopDist 10 pips at stopMult 1
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const mk = (i, o, h, l, c) => ({ openMs: T0 + i * M15, open: o, high: h, low: l, close: c });
const base = (opts) => ({ pip: PIP, atr: ATR, stopMult: 1, delayCandles: 1, holdCandles: 4, spreadPips: 0, ...opts });

test('clean timeout: rising LONG, no stop, exits at timeout close', () => {
  const cs = [mk(0, 1.10, 1.10, 1.10, 1.10),        // signal candle (idx 0)
    mk(1, 1.1000, 1.1010, 1.0998, 1.1008), mk(2, 1.1008, 1.1020, 1.1006, 1.1018), mk(3, 1.1018, 1.1030, 1.1016, 1.1028), mk(4, 1.1028, 1.1035, 1.1026, 1.1032)];
  const o = simulateReference(cs, 0, 'LONG', base());
  assert.equal(o.label, 'FILLED'); assert.equal(o.reason, 'timeout');
  assert.ok(o.netR > 0); assert.equal(o.holdBars, 4);
});

test('same-bar ambiguity: a touch of the stop is resolved conservatively AS A STOP', () => {
  const cs = [mk(0, 1.10, 1.10, 1.10, 1.10), mk(1, 1.1000, 1.1005, 1.0985, 1.1004)]; // low 1.0985 touches stop 1.0990, closes up
  const o = simulateReference(cs, 0, 'LONG', base());
  assert.equal(o.reason, 'stop'); assert.equal(o.ambiguous, true);
  assert.ok(Math.abs(o.netR + 1) < 1e-6);          // −1R, never in the trade's favour
});

test('gap through stop: a later bar OPENS beyond the stop ⇒ exit at the worse open', () => {
  const cs = [mk(0, 1.10, 1.10, 1.10, 1.10),
    mk(1, 1.1000, 1.1005, 1.0998, 1.1002),           // entry at 1.1000, stop 1.0990 (not hit)
    mk(2, 1.0980, 1.0985, 1.0975, 1.0982)];          // next bar OPENS 1.0980 < stop ⇒ gap
  const o = simulateReference(cs, 0, 'LONG', base());
  assert.equal(o.reason, 'gap_through_stop');
  assert.ok(o.netR < -1);                            // worse than −1R (gapped through)
});

test('source-stale: non-contiguous entry candle ⇒ excluded (no optimistic fill)', () => {
  const cs = [mk(0, 1.10, 1.10, 1.10, 1.10), mk(2, 1.1000, 1.1010, 1.0998, 1.1008)]; // gap: idx 2, not 1
  assert.equal(simulateReference(cs, 0, 'LONG', base()).label, 'STALE_GAP_EXCLUDED');
});

test('no-fill / no-data at entry: signal at end of data ⇒ NO_DATA_ENTRY', () => {
  const cs = [mk(0, 1.10, 1.10, 1.10, 1.10)];
  assert.equal(simulateReference(cs, 0, 'LONG', base()).label, 'NO_DATA_ENTRY');
});

test('spread + increased-spread stress reduce netR below grossR', () => {
  const cs = [mk(0, 1.10, 1.10, 1.10, 1.10), mk(1, 1.1000, 1.1010, 1.0998, 1.1008), mk(2, 1.1008, 1.1020, 1.1006, 1.1018), mk(3, 1.1018, 1.1030, 1.1016, 1.1028), mk(4, 1.1028, 1.1035, 1.1026, 1.1032)];
  const g = simulateReference(cs, 0, 'LONG', base({ spreadPips: 0 }));
  const s1 = simulateReference(cs, 0, 'LONG', base({ spreadPips: 1 }));
  const s2 = simulateReference(cs, 0, 'LONG', base({ spreadPips: 2 }));
  assert.ok(g.netR > s1.netR && s1.netR > s2.netR);  // more spread ⇒ worse net
  assert.equal(g.grossR, s1.grossR);                 // gross unchanged
});

test('one-candle delay sensitivity changes the entry and outcome', () => {
  const cs = [mk(0, 1.10, 1.10, 1.10, 1.10), mk(1, 1.1000, 1.1010, 1.0998, 1.1008), mk(2, 1.1015, 1.1020, 1.1006, 1.1018), mk(3, 1.1018, 1.1030, 1.1016, 1.1028), mk(4, 1.1028, 1.1035, 1.1026, 1.1032)];
  const d1 = simulateReference(cs, 0, 'LONG', base({ delayCandles: 1 }));
  const d2 = simulateReference(cs, 0, 'LONG', base({ delayCandles: 2 }));
  assert.notEqual(d1.entryIso, d2.entryIso);         // later entry
});

test('forwardMovement (directional edge, separate from economics)', () => {
  const cs = [mk(0, 1.10, 1.10, 1.10, 1.1000), mk(1, 0, 0, 0, 1.1005), mk(2, 0, 0, 0, 1.1010), mk(3, 0, 0, 0, 1.1012), mk(4, 0, 0, 0, 1.1020)];
  const f = forwardMovement(cs, 0, 'LONG', 4, { pip: PIP, atr: ATR });
  assert.equal(f.dirCorrect, true); assert.ok(f.pips > 0);
  // a SHORT signal over the same up-move is directionally wrong
  assert.equal(forwardMovement(cs, 0, 'SHORT', 4, { pip: PIP, atr: ATR }).dirCorrect, false);
});
