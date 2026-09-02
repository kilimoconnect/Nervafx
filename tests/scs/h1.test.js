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

// warm-up + swing low@14 (1.0989) + swing high@17 (1.1011) + sweep@20 + BOS@21
function base() {
  idx = 0;
  const a = [];
  for (let i = 0; i < 14; i++) a.push(warm());
  a.push(mk(1.1000, 1.1005, 1.0989, 1.1000)); // 14 swing low 1.0989
  a.push(warm()); a.push(warm());
  a.push(mk(1.1000, 1.1011, 1.0995, 1.1000)); // 17 swing high 1.1011
  a.push(warm()); a.push(warm());
  a.push(mk(1.1000, 1.1005, 1.0987, 1.0999)); // 20 sweep low 1.0987, closes back above 1.0989
  a.push(mk(1.1002, 1.10230, 1.1001, 1.10220)); // 21 bullish displacement BOS above 1.1011
  return a;
}
const evAt = (a) => a[a.length - 1].openMs + H1;

test('sweep + reclaim + displacement BOS → valid BUY candidate, target = entry + 2R', () => {
  const a = base();
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.triggered, true);
  assert.equal(r.candidate.direction, 'BUY');
  assert.equal(r.state, 'ENTRY_PENDING');
  assert.ok(r.candidate.rAtr <= 1.5 && r.candidate.rAtr > 0);
  const R = r.candidate.r;
  assert.ok(Math.abs((r.candidate.target - r.candidate.entry) - 2 * R) < 1e-6);
  assert.ok(Math.abs((r.candidate.entry - r.candidate.stop) - R) < 1e-6);
});

test('no sweep → WAITING_SWEEP / H1_NO_SWEEP', () => {
  idx = 0; const a = []; for (let i = 0; i < 20; i++) a.push(warm());
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.state, 'WAITING_SWEEP');
  assert.equal(r.rejection, 'H1_NO_SWEEP');
});

test('BOS beyond the 3-candle window → H1_BOS_WINDOW_EXPIRED', () => {
  const a = base();
  a.splice(21, 1);                              // remove the BOS candle
  for (let i = 0; i < 4; i++) a.push(warm());   // sweep@20, then 4 quiet candles (BOS would be at s+5)
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.state, 'WAITING_BOS');
  assert.equal(r.rejection, 'H1_BOS_WINDOW_EXPIRED');
});

test('pending entry expires after 3 completed H1 candles with no fill', () => {
  const a = base();
  for (let i = 0; i < 3; i++) a.push(mk(1.1030, 1.1035, 1.1025, 1.1030)); // hover above entry, below target
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.status, 'EXPIRED');
  assert.equal(r.rejection, 'PENDING_EXPIRED');
});

test('fill then target → TARGET_HIT (simulated)', () => {
  const a = base();
  const entryApprox = 1.1012;
  a.push(mk(1.1020, 1.1022, entryApprox - 0.0002, 1.1015)); // pulls to entry → fill
  a.push(mk(1.1015, 1.1075, 1.1014, 1.1070));               // reaches 2R target
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.status, 'TARGET_HIT');
  assert.equal(r.state, 'COMPLETED');
});

test('stop distance beyond 1.5 H1 ATR → STOP_TOO_WIDE', () => {
  // widen the structure so entry-to-stop exceeds 1.5 ATR
  const a = base();
  a[17] = mk(1.1000, 1.1030, 1.0995, 1.1000); a[17].openMs = 17 * H1; // swing high far above
  a[21] = mk(1.1002, 1.10420, 1.1001, 1.10400); a[21].openMs = 21 * H1; // BOS above 1.1030
  const r = evaluateH1(a, D1, H4, evAt(a));
  assert.equal(r.rejection, 'STOP_TOO_WIDE');
});

test('stop tighter than 3× spread → STOP_TOO_TIGHT_VS_SPREAD', () => {
  const a = base();
  const r = evaluateH1(a, D1, H4, evAt(a), { spread: 0.0020 }); // 3×spread = 0.0060 > R (~0.0027)
  assert.equal(r.rejection, 'STOP_TOO_TIGHT_VS_SPREAD');
});

test('insufficient target room before nearest opposing swing → INSUFFICIENT_TARGET_ROOM', () => {
  const a = base();
  const r = evaluateH1(a, D1, H4, evAt(a), { opposingLevels: [1.1030] }); // just above entry, < entry+2R
  assert.equal(r.rejection, 'INSUFFICIENT_TARGET_ROOM');
});
