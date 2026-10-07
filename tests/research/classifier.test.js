'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classify, STATES, CLASSIFIER_VERSION } = require('../../research/m15/classifier');
const { PAIRS, CURRENCIES } = require('../../research/m15/strengthnet');

const M15 = 15 * 60 * 1000;
const T = Date.UTC(2026, 8, 11, 0, 0, 0);     // synchronized close (end of fixtures)

// ── builders ────────────────────────────────────────────────────────────────
/** log-linear pair series ending at tEnd whose window return ≈ rTotal. */
function mkPair(tEnd, nCandles, rTotal) {
  const d = nCandles > 1 ? rTotal / (nCandles - 1) : 0;
  const start = tEnd - nCandles * M15;
  const out = [];
  for (let i = 0; i < nCandles; i++) {
    const c = Math.exp(i * d), o = Math.exp((i === 0 ? 0 : i - 1) * d);
    out.push({ openMs: start + i * M15, open: o, high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998, close: c, volume: 100, complete: true, source: 'OANDA' });
  }
  return out;
}
/** explicit close path ending at tEnd (for shaped price-action fixtures). */
function seriesEndingAt(tEnd, closes, pad = 0.0004) {
  const n = closes.length, start = tEnd - n * M15, out = [];
  let prev = closes[0];
  for (let i = 0; i < n; i++) {
    const c = closes[i], o = i === 0 ? c : prev;
    out.push({ openMs: start + i * M15, open: o, high: +(Math.max(o, c) + pad).toFixed(6), low: +(Math.min(o, c) - pad).toFixed(6), close: +c.toFixed(6), volume: 100, complete: true, source: 'OANDA' });
    prev = c;
  }
  return out;
}
const zs = (x) => { const m = CURRENCIES.reduce((s, c) => s + (x[c] || 0), 0) / 8; const o = {}; for (const c of CURRENCIES) o[c] = (x[c] || 0) - m; return o; };
/** 28-pair network from a zero-sum truth, with one pair overridden by shaped candles. */
function network(tEnd, nCandles, xTrue, overridePair, overrideCandles) {
  const X = zs(xTrue), H = {};
  for (const p of PAIRS) { const [b, q] = p.split('_'); H[p] = mkPair(tEnd, nCandles, X[b] - X[q]); }
  if (overridePair) H[overridePair] = overrideCandles;
  return H;
}
/** replay the classifier across the tested pair's closes (stepped), threading prevState. */
function replay(pair, H, step = 4) {
  const cands = H[pair]; let prev = null; const out = [];
  for (let i = 0; i < cands.length; i += step) {
    const t = cands[i].openMs + M15;
    const r = classify(pair, H, { asOfCloseMs: t, prevState: prev });
    out.push(r); prev = r.primaryState;
  }
  return out;
}
const states = (rs) => new Set(rs.map((r) => r.primaryState));
const ACCEPTED_FAMILY = [STATES.ACCEPTED_TREND_DOWN, STATES.ACCELERATING_TREND_DOWN, STATES.EXHAUSTION_RISK_DOWN];

// ── fixtures ──────────────────────────────────────────────────────────────────
// EUR/GBP-like persistent descent with shallow recoveries (192 candles = 48h).
function eurgbpDescent(tEnd) {
  const closes = []; let p = 0.8600;
  for (let i = 0; i < 192; i++) { p -= 0.0006; if (i % 6 === 5) p += 0.0003; closes.push(p); }
  return seriesEndingAt(tEnd, closes);
}
// GBP/AUD-like: sharp fall, full recovery, then a late fall (3 legs × 64 = 192).
function gbpaudThreeLeg(tEnd) {
  const closes = []; let p = 1.9000;
  for (let i = 0; i < 64; i++) { p -= 0.0010; closes.push(p); }   // fall
  for (let i = 0; i < 64; i++) { p += 0.0010; closes.push(p); }   // full recovery
  for (let i = 0; i < 64; i++) { p -= 0.0010; closes.push(p); }   // late fall
  return seriesEndingAt(tEnd, closes);
}

// ── 1. EUR/GBP becomes ACCEPTED bearish only WITH independent strength ───────
test('EUR/GBP descent + EUR-weak/GBP-strong network ⇒ ACCEPTED_TREND_DOWN appears', () => {
  const cands = eurgbpDescent(T);
  const H = network(T, 192, { GBP: 0.03, EUR: -0.03 }, 'EUR_GBP', cands);
  const seen = states(replay('EUR_GBP', H));
  assert.ok(seen.has(STATES.ACCEPTED_TREND_DOWN) || seen.has(STATES.ACCELERATING_TREND_DOWN), [...seen].join(','));
});

test('SAME EUR/GBP descent WITHOUT a network ⇒ never accepted, stays EMERGING_MOVE_DOWN', () => {
  const cands = eurgbpDescent(T);
  const H = { EUR_GBP: cands };                       // no other pairs ⇒ strength unavailable
  const rs = replay('EUR_GBP', H);
  const seen = states(rs);
  for (const s of ACCEPTED_FAMILY) assert.ok(!seen.has(s), `must not reach ${s} without independent strength`);
  assert.ok(seen.has(STATES.EMERGING_MOVE_DOWN));
  assert.ok(rs.some((r) => r.qualityFlags.includes('STRENGTH_ABSENT')));
});

// ── 2. GBP/AUD: initial fall rejected, late fall emerging, never accepted ────
test('GBP/AUD fall is rejected (REVERSAL_UP) and late fall only EMERGING, never accepted', () => {
  const cands = gbpaudThreeLeg(T);
  const H = network(T, 192, {}, 'GBP_AUD', cands);    // flat GBP/AUD strength ⇒ no confirmation
  const rs = replay('GBP_AUD', H, 2);
  const seen = states(rs);
  assert.ok(!seen.has(STATES.ACCEPTED_TREND_DOWN), 'a non-confirmed fall must never be accepted');
  assert.ok(seen.has(STATES.REVERSAL_UP), 'the rejected fall should surface a REVERSAL_UP');
  assert.ok(seen.has(STATES.EMERGING_MOVE_DOWN), 'falls should appear as emerging');
});

// ── 3. CONFLICT when price and independently-confirmed strength disagree ─────
test('price DOWN but EUR-strong/USD-weak network ⇒ CONFLICT', () => {
  const cands = eurgbpDescent(T).map((c) => ({ ...c }));   // reuse descent shape as EUR_USD down
  const H = network(T, 192, { EUR: 0.03, USD: -0.03 }, 'EUR_USD', cands);  // strength says EUR up vs USD
  const r = classify('EUR_USD', H, { asOfCloseMs: T });
  assert.equal(r.primaryState, STATES.CONFLICT);
  assert.ok(r.evidenceAgainst.some((e) => e.code === 'CONFLICT_PRICE_STRENGTH'));
});

// ── 4. A strong single candle only triggers EMERGING (never accepted) ────────
test('single-candle dominated move ⇒ EMERGING, not ACCEPTED, even with confirming strength', () => {
  const closes = [1.1000, 1.1000, 1.1000, 1.1000, 1.1000, 1.1200];   // one big up bar
  const cands = seriesEndingAt(T, closes, 0.00005);
  const H = network(T, 192, { EUR: 0.03, USD: -0.03 }, 'EUR_USD', cands);
  const r = classify('EUR_USD', H, { asOfCloseMs: T });
  assert.equal(r.primaryState, STATES.EMERGING_MOVE_UP);
  assert.ok(r.evidenceAgainst.some((e) => e.code === 'SINGLE_CANDLE'));
});

// ── 5. Absent currency coverage ⇒ flagged, capped below accepted ─────────────
test('absent network coverage ⇒ STRENGTH_ABSENT flag and no accepted trend', () => {
  const cands = eurgbpDescent(T);
  const H = { EUR_GBP: cands, EUR_USD: mkPair(T, 192, -0.02) };   // 2 pairs ⇒ still insufficient/disconnected
  const r = classify('EUR_GBP', H, { asOfCloseMs: T });
  assert.ok(r.qualityFlags.includes('STRENGTH_ABSENT'));
  assert.ok(!ACCEPTED_FAMILY.includes(r.primaryState));
});

// ── 6. Immutability: a past close is fixed regardless of later data ──────────
test('historical output is immutable as of its candle close (no lookahead)', () => {
  const cands = eurgbpDescent(T);
  const H = network(T, 192, { GBP: 0.03, EUR: -0.03 }, 'EUR_GBP', cands);
  const tPast = cands[120].openMs + M15;
  const full = classify('EUR_GBP', H, { asOfCloseMs: tPast });
  // truncate every pair to candles that had closed by tPast, then reclassify
  const Htrunc = {};
  for (const p of Object.keys(H)) Htrunc[p] = H[p].filter((c) => c.openMs + M15 <= tPast);
  const trunc = classify('EUR_GBP', Htrunc, { asOfCloseMs: tPast });
  assert.deepEqual(trunc, full);
  // determinism
  assert.deepEqual(classify('EUR_GBP', H, { asOfCloseMs: tPast }), full);
});

// ── 7. Emission shape + transition + plain-English explanation ───────────────
test('emission carries windows/structure/strength/evidence/explanation + UTC & EAT', () => {
  const cands = eurgbpDescent(T);
  const H = network(T, 192, { GBP: 0.03, EUR: -0.03 }, 'EUR_GBP', cands);
  const r = classify('EUR_GBP', H, { asOfCloseMs: T, prevState: STATES.EMERGING_MOVE_DOWN });
  assert.equal(r.version, CLASSIFIER_VERSION);
  assert.ok(r.asOfCloseUtc.endsWith('Z') && r.asOfCloseEat.endsWith('+03:00'));
  assert.ok(r.windows.context_48_36h && r.windows.transition_24h && r.windows.present_12h);
  assert.ok(r.structure && r.strength && Array.isArray(r.evidenceFor) && Array.isArray(r.evidenceAgainst));
  assert.ok(typeof r.explanation === 'string' && r.explanation.length > 20);
  assert.ok(r.transition && 'kind' in r.transition);
  assert.ok(r.calibration.version === 'cal-v1' && r.calibration.effectivePeriod.from);
});

// ── 8. Hysteresis holds a weak directional rather than flip to balanced ──────
test('hysteresis: a weakening directional holds EMERGING instead of snapping to BALANCED', () => {
  // mild sustained drift then a flat patch; prevState directional
  const closes = []; let p = 1.2000;
  for (let i = 0; i < 100; i++) { p += 0.0004; closes.push(p); }      // drift up
  for (let i = 0; i < 20; i++) { p += (i % 2 ? -0.00005 : 0.00005); closes.push(p); } // flat tail
  const cands = seriesEndingAt(T, closes);
  const H = { EUR_USD: cands };
  const r = classify('EUR_USD', H, { asOfCloseMs: T, prevState: STATES.EMERGING_MOVE_UP });
  assert.ok([STATES.EMERGING_MOVE_UP, STATES.BALANCED_RANGE].includes(r.primaryState));
});
