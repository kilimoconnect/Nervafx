'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { horizon, laggedScale, pairFeatures, currencyMovement, logReturns, split } = require('../../research/m15/features');
const { featureSnapshot } = require('../../research/m15/featureSnapshot');
const { PAIRS, M15 } = require('../../research/m15/loader');

// closes from a starting price and a list of per-bar log returns
function closesFrom(p0, rs) { const c = [p0]; for (const r of rs) c.push(c[c.length - 1] * Math.exp(r)); return c; }
function candlesFrom(closes) { return closes.map((c, i) => ({ openMs: Date.UTC(2026, 0, 1) + i * M15, time: '', open: i ? closes[i - 1] : c, high: Math.max(c, i ? closes[i - 1] : c) * 1.0001, low: Math.min(c, i ? closes[i - 1] : c) * 0.9999, close: c, volume: 100, complete: true, source: 'OANDA' })); }

test('horizon identity: U−D == R, U+D == path, P == 100·R/path, efficiency == |P|/100', () => {
  const closes = closesFrom(1.10, [0.001, -0.0005, 0.002, -0.001, 0.0015, 0.0004]);
  const h = horizon(closes, 4);
  assert.ok(h.identityHolds);                                 // U−D === R
  assert.ok(Math.abs((h.U + h.D) - h.path) < 1e-12);
  assert.ok(Math.abs(h.P - 100 * h.R / (h.path + 1e-12)) < 1e-9);
  assert.ok(Math.abs(h.efficiency - Math.abs(h.P) / 100) < 1e-12); // derived, same info as |P|
});

test('zero movement is explicit: flat closes ⇒ P=0, efficiency=0, NEUTRAL', () => {
  const closes = [1.1, 1.1, 1.1, 1.1, 1.1, 1.1];
  const h = horizon(closes, 4);
  assert.equal(h.zeroMovement, true);
  assert.equal(h.P, 0); assert.equal(h.efficiency, 0); assert.equal(h.direction, 'NEUTRAL');
});

test('blocks reconstruct R10 and use per-candle rates (no recounting)', () => {
  const rs = Array.from({ length: 12 }, (_, i) => ((i * 7 % 5) - 2) * 0.0003);
  const f = pairFeatures(candlesFrom(closesFrom(1.10, rs)), { pair: 'EUR_USD' });
  assert.ok(f.blocks.reconstructsR10);                        // B1+B2+B3+B4 === R10
  assert.equal(f.blocks.B1.bars, 4); assert.equal(f.blocks.B2.bars, 2);
  assert.ok(Math.abs(f.blocks.B1.perCandle - f.blocks.B1.ret / 4) < 1e-12);
});

test('normalization uses the LAGGED empirical N-bar scale and is scale-invariant', () => {
  const rs = Array.from({ length: 80 }, (_, i) => Math.sin(i) * 0.0006);
  const closes = closesFrom(1.10, rs);
  const s = laggedScale(closes, 4); assert.ok(s.scale > 0 && s.obs >= 30);
  const f1 = pairFeatures(candlesFrom(closes), { pair: 'EUR_USD' });
  // scaling every price by k scales R and scale by k ⇒ z unchanged (empirical, not assumed σ√N)
  const f2 = pairFeatures(candlesFrom(closes.map((c) => c * 3.7)), { pair: 'EUR_USD' });
  assert.ok(Math.abs(f1.horizons[4].z - f2.horizons[4].z) < 1e-9);
});

test('currency network: zero-sum and x_{c}=(1/8)·Σ sign·R', () => {
  const R = {}; for (const p of PAIRS) R[p] = 0; R['EUR_USD'] = 0.01;    // only EUR/USD moved up
  const net = currencyMovement(R, { N: 4 });
  assert.equal(net.zeroSum, true);
  assert.ok(Math.abs(net.x['EUR'] - 0.01 / 8) < 1e-12);
  assert.ok(Math.abs(net.x['USD'] + 0.01 / 8) < 1e-12);
  // cross-pair SIGN correctness: gap sign agrees with the pair's own direction
  assert.ok(net.gap['EUR_USD'] > 0);                          // EUR up vs USD ⇒ gap > 0 (pair up)
});

test('inverted base/quote sign flips that pair’s contribution and gap', () => {
  const up = {}; for (const p of PAIRS) up[p] = 0; up['GBP_JPY'] = 0.02;
  const dn = { ...up, GBP_JPY: -0.02 };                       // inverted sign
  const a = currencyMovement(up, { N: 6 }), b = currencyMovement(dn, { N: 6 });
  assert.ok(a.x['GBP'] > 0 && b.x['GBP'] < 0);
  assert.ok(Math.sign(a.gap['GBP_JPY']) === -Math.sign(b.gap['GBP_JPY']));
});

test('missing pair is skipped, breadth participation drops, zero-sum still holds', () => {
  const R = {}; for (const p of PAIRS) R[p] = 0.0005; R['CHF_JPY'] = null;   // missing
  const net = currencyMovement(R, { N: 8 });
  assert.equal(net.zeroSum, true);
  assert.ok(net.breadth['CHF'].participating < 7);             // CHF lost one relationship
});

test('ACCEPTANCE: gap is exactly RAW x_base−x_quote (comparable units, no separate standardization)', () => {
  const R = {}; for (const p of PAIRS) R[p] = ((PAIRS.indexOf(p) % 5) - 2) * 0.0007; // varied network
  const net = currencyMovement(R, { N: 4 });
  for (const p of PAIRS) { const { base, quote } = split(p);
    assert.ok(Math.abs(net.gap[p] - (net.x[base] - net.x[quote])) < 1e-15); // raw, same units
  }
});

test('ACCEPTANCE: mismatched per-currency standardization CAN reverse the true direction — which is why we use raw', () => {
  // Same-sign case: both currencies weak vs the basket, base weaker by less.
  const xBase = 0.001, xQuote = 0.002;         // raw: base − quote = −0.001 ⇒ base relatively WEAKER
  const rawGap = xBase - xQuote;
  assert.ok(rawGap < 0);                        // true relative direction: base weaker
  const sBase = 0.005, sQuote = 0.05;           // mismatched per-currency scales (or tanh saturation)
  const wrongGap = xBase / sBase - xQuote / sQuote; // 0.2 − 0.04 = +0.16
  assert.ok(wrongGap > 0);                      // separately-normalized flips to "base stronger"
  assert.notEqual(Math.sign(rawGap), Math.sign(wrongGap)); // the reversal our raw gap avoids
});

test('featureSnapshot is deterministic and no-lookahead (bitwise inputHash)', () => {
  const rs = Array.from({ length: 60 }, (_, i) => ((i % 7) - 3) * 0.0002);
  const hist = {}; for (const p of PAIRS) hist[p] = candlesFrom(closesFrom(1.10, rs));
  const T = hist['EUR_USD'][hist['EUR_USD'].length - 1].openMs + M15; // close after the last candle
  const a = featureSnapshot(hist, T), b = featureSnapshot(hist, T);
  assert.equal(a.ok, true);
  assert.equal(a.inputHash, b.inputHash);
  assert.equal(a.network[4].zeroSum, true);
  // no candle in the snapshot closes after T
  for (const p of PAIRS) for (const c of require('../../research/m15/loader').syncAsOf(hist, T).bySync[p]) assert.ok(c.openMs + M15 <= T);
});
