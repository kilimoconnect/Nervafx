'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyze, ANALYSIS_VERSION } = require('../../research/m15/analysis');

const M15 = require('../../research/m15/timeframe').INTERVAL_MS;
const { BLOCK_HOURS, CANDLES_PER_HOUR } = require('../../research/m15/timeframe');
const BLOCK_C = BLOCK_HOURS * CANDLES_PER_HOUR;   // candles per non-overlapping block
const START = Date.UTC(2026, 0, 5, 0, 0, 0);       // Monday
function mk(closes, startMs) { return closes.map((cl, i) => { const o = i === 0 ? cl : closes[i - 1]; return { openMs: (startMs || START) + i * M15, open: o, high: Math.max(o, cl), low: Math.min(o, cl), close: cl, complete: true, source: 'OANDA' }; }); }
const closeMs = (c) => c.openMs + M15;
const bs = (byCurrency, breadth) => ({ available: true, effects: { byCurrency }, breadth: breadth || {} });
const filled = (eur, gbp) => ({ USD: 0, EUR: eur, GBP: gbp, JPY: 0, AUD: 0, NZD: 0, CAD: 0, CHF: 0 });
function series192(fn, startMs) { const cl = []; for (let i = 0; i < 192; i++) cl.push(fn(i)); return mk(cl, startMs); }

test('versioned, additive', () => { assert.equal(ANALYSIS_VERSION, 'm15-analysis-1.0.0'); });

test('old decline then recent recovery ⇒ latest block conflicts with the earlier structure', () => {
  let p = 100, cl = [];
  for (let i = 0; i < 3 * BLOCK_C; i++) { p -= 0.01; cl.push(+p.toFixed(4)); }   // blocks 3–1 (oldest) down
  for (let i = 0; i < BLOCK_C; i++) { p += 0.02; cl.push(+p.toFixed(4)); }        // block 0 (newest) up
  const cc = mk(cl); const a = analyze(cc, { asOfCloseMs: closeMs(cc[cc.length - 1]) });
  assert.equal(a.blocks[0].metrics.direction, 'UP');
  assert.equal(a.blocks[3].metrics.direction, 'DOWN');
  assert.equal(a.recentVsEarlier.verdict, 'conflicts');
});

test('high price travel with little net progress ⇒ back-and-forth / congestion, not sustained', () => {
  let p = 100, cl = [];
  for (let i = 0; i < 144; i++) { p += 0.01; cl.push(+p.toFixed(4)); }
  for (let i = 0; i < 48; i++) cl.push(+((i % 2 ? p + 0.08 : p)).toFixed(4));  // oscillate: big travel, ~0 net
  const cc = mk(cl); const a = analyze(cc, { asOfCloseMs: closeMs(cc[cc.length - 1]) });
  assert.ok(Math.abs(a.blocks[0].metrics.efficiency) < 0.5);
  assert.ok(['back_and_forth', 'congestion'].includes(a.progressQuality.label));
});

test('broad currency support becoming concentrated ⇒ breadthTrend narrowing', () => {
  const by = filled(-0.004, 0.004);   // GBP stronger than EUR (EUR_GBP down)
  const blockStrength = [bs(by, { EUR: { fraction: 0.3 }, GBP: { fraction: 0.3 } }), bs(by, { EUR: { fraction: 0.9 }, GBP: { fraction: 0.9 } }), bs(by, { EUR: { fraction: 0.9 }, GBP: { fraction: 0.9 } }), bs(by, { EUR: { fraction: 0.9 }, GBP: { fraction: 0.9 } })];
  const a = analyze(series192((i) => 100 - i * 0.002), { pair: 'EUR_GBP', asOfCloseMs: START + 192 * M15, blockStrength });
  assert.equal(a.currencySupport.available, true);
  assert.equal(a.currencySupport.baseBehavior.breadthTrend, 'narrowing');
});

test('strong base AND strong quote but little pair direction ⇒ two-way activity, net unclear', () => {
  const by = filled(0.005, 0.005);    // both strong, gap ≈ 0
  const blockStrength = [bs(by), bs(by), bs(by), bs(by)];
  const a = analyze(series192((i) => 100 + 0.0002 * (i % 2)), { pair: 'EUR_GBP', asOfCloseMs: START + 192 * M15, blockStrength });
  assert.equal(a.currencySupport.bothCurrenciesActive, true);
  assert.equal(a.currencySupport.netDirectionUnclear, true);
});

test('missing candles stay visible (coverage < 100) and zero adaptive scale is handled', () => {
  let p = 100, cl = [];
  for (let i = 0; i < 144; i++) { p += 0.02; cl.push(+p.toFixed(4)); }     // varying earlier blocks
  for (let i = 0; i < 48; i++) cl.push(100.0);                             // latest 12h FLAT ⇒ zero scale
  const full = mk(cl); const cands = full.slice(0, 180).concat(full.slice(185));   // drop 5 candles ⇒ a gap in block 0
  const a = analyze(cands, { asOfCloseMs: closeMs(full[191]) });
  assert.ok(a.blocks[0].coveragePct < 100);
  assert.equal(a.blocks[0].scaleAvailable, false);                         // flat ⇒ zero scale
  assert.equal(a.blocks[0].metrics.netProgressScaleUnits, null);
  assert.ok(a.dataHealth.gaps.length >= 1);
});

test('market closure handling: a weekend block reports fewer expected-open candles', () => {
  const sat = Date.UTC(2026, 0, 3, 0, 0, 0);   // Saturday
  const a = analyze(series192((i) => 100 + 0.001 * i, sat), { asOfCloseMs: sat + 48 * M15 });   // T ~12h into Saturday
  assert.ok(a.blocks[0].expectedOpenCandles < a.blocks[0].nominalCandles);   // closure reduces expected candles
});

test('structural reference is unavailable until its pivot is CONFIRMED (knowable timestamp)', () => {
  const SCALE = []; for (let i = 0; i < 20; i++) SCALE.push(i % 2 ? 100.1 : 100.0);
  const cl = SCALE.concat([99.7, 99.5, 99.9, 100.4, 100.9, 101.4, 101.0, 100.7, 100.6]);   // high 101.4 confirms during the pullback
  const cands = mk(cl);
  const atExtreme = analyze(cands, { asOfCloseMs: closeMs(cands[25]) });    // the 101.4 candle — not yet confirmed
  const shEarly = atExtreme.structuralLocation.references.find((r) => r.kind === 'confirmed_swing_high');
  assert.ok(!shEarly || shEarly.price !== 101.4);                           // the 101.4 extreme is NOT yet a confirmed reference
  const later = analyze(cands, { asOfCloseMs: closeMs(cands[cands.length - 1]) });
  const sh = later.structuralLocation.references.find((r) => r.kind === 'confirmed_swing_high');
  assert.ok(sh && sh.confirmed && sh.price === 101.4 && sh.knownSinceMs > closeMs(cands[25]));   // knowable only at confirmation, after the extreme
});

test('identical as-of result when FUTURE candles are appended (no look-ahead)', () => {
  const cands = series192((i) => 100 + Math.sin(i / 7) * 0.5 - i * 0.001);
  const T = closeMs(cands[191]);
  const future = cands.concat(mk([99, 98, 101, 103], cands[191].openMs + M15));
  const a = analyze(cands, { asOfCloseMs: T });
  const b = analyze(future, { asOfCloseMs: T });
  assert.deepEqual(a, b);
});
