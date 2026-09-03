'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateH1 } = require('../../api/_scs-h1');

const H1 = 3600000;
const D1 = { direction: 'BULLISH' };
const H4 = { state: 'PULLBACK_ACTIVE', impulse: { id: 'H4-BULL-1' } };
let idx = 0;
const mk = (o, h, l, c) => ({ openMs: (idx++) * H1, open: o, high: h, low: l, close: c });
const warm = () => mk(1.1000, 1.1010, 1.0990, 1.1000);   // range 0.0020 → ATR 0.0020, no swings

// warm-up + pullback swing low@14 (1.0989) + swing high@17 (1.1011) + bullish H1 BOS@21
function base() {
  idx = 0;
  const a = [];
  for (let i = 0; i < 14; i++) a.push(warm());
  a.push(mk(1.1000, 1.1005, 1.0989, 1.1000)); // 14 pullback swing low 1.0989 (stop reference)
  a.push(warm()); a.push(warm());
  a.push(mk(1.1000, 1.1011, 1.0995, 1.1000)); // 17 swing high 1.1011 (to be broken)
  a.push(warm()); a.push(warm()); a.push(warm());
  a.push(mk(1.1002, 1.10230, 1.1001, 1.10220)); // 21 H1 BOS: closes above 1.1011 by the BOS distance
  return a;
}
const evAt = (a) => a[a.length - 1].openMs + H1;

test('H1 BOS above the pullback swing high → BUY candidate; entry=broken high, stop below pullback low, target=entry+2R', () => {
  const r = evaluateH1(base(), D1, H4, evAt(base()));
  assert.equal(r.triggered, true);
  assert.equal(r.bosConfirmed, true);
  assert.equal(r.candidate.direction, 'BUY');
  assert.equal(r.state, 'ENTRY_PENDING');
  assert.equal(r.candidate.entry, 1.1011);           // retracement to the broken H1 high
  assert.ok(r.candidate.stop < 1.0989);              // below the pullback swing low
  const R = r.candidate.r;
  assert.ok(Math.abs((r.candidate.target - r.candidate.entry) - 2 * R) < 1e-6);
  assert.ok(Math.abs((r.candidate.entry - r.candidate.stop) - R) < 1e-6);
  assert.ok(r.candidate.rAtr <= 1.5 && r.candidate.rAtr > 0);
});

test('no H1 BOS during the pullback → WAITING_BOS / H1_NO_BOS (no sweep step)', () => {
  idx = 0; const a = []; for (let i = 0; i < 22; i++) a.push(warm());
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.state, 'WAITING_BOS');
  assert.equal(r.rejection, 'H1_NO_BOS');
  assert.equal(r.bosConfirmed, false);
});

test('retracement fill then target → TARGET_HIT', () => {
  const a = base();
  a.push(mk(1.1020, 1.1022, 1.1010, 1.1015)); // pulls back to entry 1.1011 → fill
  a.push(mk(1.1015, 1.1065, 1.1014, 1.1060)); // reaches 2R target
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.status, 'TARGET_HIT');
  assert.equal(r.state, 'COMPLETED');
});

test('target reached before retracement → ENTRY_MISSED', () => {
  const a = base();
  a.push(mk(1.1023, 1.1065, 1.1022, 1.1060)); // never dips to entry (low 1.1022 > 1.1011), hits target first
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.status, 'CANCELLED');
  assert.equal(r.rejection, 'ENTRY_MISSED');
});

test('retracement entry expires after 3 completed H1 candles with no fill', () => {
  const a = base();
  for (let i = 0; i < 3; i++) a.push(mk(1.1030, 1.1035, 1.1025, 1.1030)); // hover above entry, below target
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.status, 'EXPIRED');
  assert.equal(r.rejection, 'PENDING_EXPIRED');
});

test('stop beyond 1.5 H1 ATR → STOP_TOO_WIDE (BOS still confirmed)', () => {
  const a = base();
  a[17] = mk(1.1000, 1.1030, 1.0995, 1.1000); a[17].openMs = 17 * H1;   // swing high far above the pullback low
  a[21] = mk(1.1002, 1.10420, 1.1001, 1.10400); a[21].openMs = 21 * H1; // BOS above 1.1030
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.rejection, 'STOP_TOO_WIDE');
  assert.equal(r.bosConfirmed, true);
});

test('stop tighter than 3× spread → STOP_TOO_TIGHT_VS_SPREAD', () => {
  assert.equal(evaluateH1(base(), D1, H4, evAt(base()), { spread: 0.0020 }).rejection, 'STOP_TOO_TIGHT_VS_SPREAD');
});

test('insufficient target room before nearest opposing swing → INSUFFICIENT_TARGET_ROOM', () => {
  assert.equal(evaluateH1(base(), D1, H4, evAt(base()), { opposingLevels: [1.1030] }).rejection, 'INSUFFICIENT_TARGET_ROOM');
});

test('H4 not in pullback → H4_NO_IMPULSE (no candidate)', () => {
  const r = evaluateH1(base(), D1, { state: 'IMPULSE_ACTIVE', impulse: {} }, evAt(base()));
  assert.equal(r.state, 'WAITING_BOS');
  assert.equal(r.rejection, 'H4_NO_IMPULSE');
});
