'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateCompression } = require('../../api/_m15/compression');
const { mk, flat } = require('./_helpers');

/** Big zigzag for `a` candles, then tiny ranges for `b` candles (a contraction). */
function contractAfterVol(a, b, base = 1.1000) {
  const out = []; let idx = 0; let p = base;
  for (let i = 0; i < a; i++) { const dir = i % 2 ? 1 : -1; const o = p; p = base + dir * 0.0015; out.push(mk(idx++, o, Math.max(o, p) + 0.0020, Math.min(o, p) - 0.0020, p)); }
  for (let i = 0; i < b; i++) { const o = p; p = base + (i % 2 ? 0.00005 : -0.00005); out.push(mk(idx++, o, Math.max(o, p) + 0.00008, Math.min(o, p) - 0.00008, p)); }
  return out;
}

test('vol contracting vs its own baseline ⇒ compression detected (ACTIVE/TIGHT/FORMING)', () => {
  const r = evaluateCompression(contractAfterVol(60, 20), { pair: 'EUR_USD' });
  assert.ok(['FORMING', 'ACTIVE', 'TIGHT'].includes(r.state), `got ${r.state}`);
  assert.ok(r.contractionRatio < 0.9, `fast vol should be below baseline, got ${r.contractionRatio}`);
});

test('adaptive, NOT candle-count based: same contraction detected at 15 or 40 candles long (§32)', () => {
  const short = evaluateCompression(contractAfterVol(60, 15), { pair: 'EUR_USD' });
  const long = evaluateCompression(contractAfterVol(60, 40), { pair: 'EUR_USD' });
  for (const r of [short, long]) assert.ok(['FORMING', 'ACTIVE', 'TIGHT'].includes(r.state));
});

test('perpetually dead-flat market is NOT compression (ratio ≈ 1, no contraction)', () => {
  const r = evaluateCompression(flat(120), { pair: 'EUR_USD' });
  assert.equal(r.state, 'NONE');
});

test('expanding out of a prior compression ⇒ RELEASING (coordinator prevState)', () => {
  // Long quiet baseline, then a directional burst; fast vol clears the slow base.
  const c = []; let idx = 0; let p = 1.1000;
  for (let i = 0; i < 90; i++) { const o = p; p = 1.1000 + (i % 2 ? 0.00004 : -0.00004); c.push(mk(idx++, o, Math.max(o, p) + 0.00006, Math.min(o, p) - 0.00006, p)); }
  for (let k = 0; k < 14; k++) { const o = p; p = o + 0.0016; c.push(mk(idx++, o, p + 0.0003, o - 0.0002, p)); }
  const r = evaluateCompression(c, { pair: 'EUR_USD', prevState: 'TIGHT' });
  assert.ok(r.expanding, `tail should be expanding, ratio=${r.contractionRatio}`);
  assert.equal(r.state, 'RELEASING');
});

test('deterministic', () => {
  const c = contractAfterVol(50, 20);
  assert.deepEqual(evaluateCompression(c, { pair: 'EUR_USD' }), evaluateCompression(c, { pair: 'EUR_USD' }));
});
