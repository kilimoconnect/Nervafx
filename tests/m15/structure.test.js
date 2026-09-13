'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectStructure, EV } = require('../../api/_m15/structure');
const { instrumentMinThreshold } = require('../../api/_m15/pairs');
const { flat, zigzag, scaleVol } = require('./_helpers');

test('deterministic: identical candles ⇒ identical events', () => {
  const c = zigzag(120);
  assert.deepEqual(detectStructure(c, { pair: 'EUR_USD' }), detectStructure(c, { pair: 'EUR_USD' }));
});

test('adaptive, NOT candle-count based: a long dead market never manufactures a leg (§6)', () => {
  const c = flat(500); // 500 candles of near-zero movement
  const r = detectStructure(c, { pair: 'EUR_USD' });
  assert.equal(r.events.length, 0, 'no structural events from a dead market regardless of length');
  assert.equal(r.current.direction, 'NONE');
});

test('instrument minimum threshold is the hard floor when volatility ≈ 0', () => {
  const c = flat(50);
  const r = detectStructure(c, { pair: 'EUR_USD' });
  assert.ok(Math.abs(r.thresholdLast - instrumentMinThreshold('EUR_USD')) < 1e-12);
});

test('threshold scales with volatility (adaptive to the pair, not fixed)', () => {
  const base = zigzag(120);
  const hot = scaleVol(base, 3);
  const rBase = detectStructure(base, { pair: 'EUR_USD' });
  const rHot = detectStructure(hot, { pair: 'EUR_USD' });
  assert.ok(rHot.thresholdLast > rBase.thresholdLast * 2,
    'tripling ranges must materially raise the reversal threshold');
});

test('a clean zigzag produces alternating UP/DOWN structural starts', () => {
  const r = detectStructure(zigzag(160, 1.1, 0.006, 12), { pair: 'EUR_USD' });
  const starts = r.events.filter((e) => e.type === EV.UP_START || e.type === EV.DN_START);
  assert.ok(starts.length >= 4, 'expected several legs');
  for (let i = 1; i < starts.length; i++) {
    assert.notEqual(starts[i].type, starts[i - 1].type, 'leg starts must alternate direction');
  }
});

test('NO LOOK-AHEAD: events on a prefix are a prefix of events on the full series (§10, §28)', () => {
  const full = zigzag(200, 1.1, 0.006, 14);
  const rFull = detectStructure(full, { pair: 'EUR_USD' });
  for (const k of [40, 80, 130, 175]) {
    const rPre = detectStructure(full.slice(0, k), { pair: 'EUR_USD' });
    // every event the prefix knows about must match the full run exactly (same
    // type, index, price) — the past cannot be rewritten by future candles.
    for (let i = 0; i < rPre.events.length; i++) {
      const a = rPre.events[i], b = rFull.events[i];
      assert.equal(a.type, b.type);
      assert.equal(a.index, b.index);
      assert.equal(a.price, b.price);
    }
  }
});

test('trend age is measured in structural events, never a candle count', () => {
  const r = detectStructure(zigzag(160, 1.1, 0.006, 12), { pair: 'EUR_USD' });
  if (r.current.direction !== 'NONE') {
    assert.equal(typeof r.current.ageEvents, 'number');
    assert.ok(!('ageCandles' in r.current));
  }
});
