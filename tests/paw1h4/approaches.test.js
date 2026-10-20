'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectRangeRejection, detectAcceptedBreakout, detectFailedBreakout } = require('../../research/paw1h4/approaches');
const { CONFIG, H4_MS } = require('../../research/paw1h4/config');

const START = Date.UTC(2026, 0, 5, 0, 0, 0);
function bars(rows) { return rows.map((r, i) => { const o = START + i * H4_MS; return { openMs: o, closeMs: o + H4_MS, open: (r[0] + r[1]) / 2, high: r[0], low: r[1], close: r[2] }; }); }
function ctxStub(h4, balance, opts) {
  opts = opts || {};
  return {
    pair: 'EUR_USD', balance,
    references: { structuralHighs: opts.highs || [], structuralLows: opts.lows || [] },
    _internal: { h4, pip: 0.0001, buffer: opts.buffer || 0.0002 },
  };
}
const established = new Date(START - H4_MS).toISOString();
const pick = (arr, dir) => arr.find((c) => c.dir === dir);

test('valid RANGE_REJECTION (long) at lower → CONFIRMED with mid objective', () => {
  const bal = { confirmed: true, lower: 1.1000, upper: 1.2000, mid: 1.1500, widthPips: 1000, establishedUtc: established };
  const h4 = bars([
    [1.1050, 1.1010, 1.1020],
    [1.1030, 1.0990, 1.1010],   // wick below 1.10, close inside → rejection, extreme 1.0990
    [1.1060, 1.1020, 1.1040],   // close 1.1040 > prior high 1.1030 → confirmation
    [1.1080, 1.1030, 1.1060],   // entry bar (open = mid of this bar)
  ]);
  const c = pick(detectRangeRejection(ctxStub(h4, bal), CONFIG), 'BUY');
  assert.equal(c.state, 'CONFIRMED');
  assert.equal(c.reference.boundary, 'lower');
  assert.equal(c.frozenExtreme, 1.0990);
  assert.equal(c.objective, 1.1500);
  assert.ok(c.invalidation < 1.0990);
  assert.equal(c.economics.economicEligibility, 'ELIGIBLE');
});

test('middle-of-range chop → no rejection (NO_SETUP)', () => {
  const bal = { confirmed: true, lower: 1.1000, upper: 1.2000, mid: 1.1500, widthPips: 1000, establishedUtc: established };
  const h4 = bars([[1.1550, 1.1450, 1.1500], [1.1560, 1.1460, 1.1520], [1.1540, 1.1440, 1.1480]]); // never touches a boundary
  const c = pick(detectRangeRejection(ctxStub(h4, bal), CONFIG), 'BUY');
  assert.equal(c.state, 'NO_SETUP');
});

test('ACCEPTED_BREAKOUT (long) above the upper boundary → labelled H4 accepted departure', () => {
  const bal = { confirmed: true, lower: 1.1000, upper: 1.1200, mid: 1.1100, widthPips: 200, establishedUtc: established };
  const h4 = bars([
    [1.1180, 1.1100, 1.1150],
    [1.1260, 1.1190, 1.1250],   // close > upper
    [1.1320, 1.1240, 1.1300],   // 2nd close > upper + progress → accepted
    [1.1340, 1.1280, 1.1320],
  ]);
  const c = pick(detectAcceptedBreakout(ctxStub(h4, bal, { highs: [{ price: 1.1600, knownUtc: established }] }), CONFIG), 'BUY');
  assert.ok(['CONFIRMED', 'OBJECTIVE_UNAVAILABLE', 'INELIGIBLE_ECONOMICS'].includes(c.state));
  assert.ok(/accepted departure/i.test(c.label));
  assert.equal(c.objective, 1.1600);   // next structural level above the breakout extreme
});

test('FAILED_BREAKOUT (long): downward departure reclaims range → return-into-range candidate', () => {
  const bal = { confirmed: true, lower: 1.1000, upper: 1.2000, mid: 1.1500, widthPips: 1000, establishedUtc: established };
  const h4 = bars([
    [1.1050, 1.1010, 1.1020],
    [1.1010, 1.0900, 1.0950],   // close below lower (attempted departure)
    [1.1120, 1.1000, 1.1080],   // reclaim: close back inside
    [1.1150, 1.1060, 1.1130],   // close > reclaim bar high (1.1120) → failure confirmed
    [1.1180, 1.1100, 1.1150],   // entry bar
  ]);
  const c = pick(detectFailedBreakout(ctxStub(h4, bal), CONFIG), 'BUY');
  assert.equal(c.reference.boundary, 'lower');
  assert.equal(c.frozenExtreme, 1.0900);
  assert.equal(c.objective, 1.1500);
  assert.ok(['CONFIRMED', 'INELIGIBLE_ECONOMICS', 'OBJECTIVE_UNAVAILABLE'].includes(c.state));
  assert.ok(c.priorAccepted === false);
});

test('a plain wick is NOT a failed breakout (needs an attempted departure = a close beyond)', () => {
  const bal = { confirmed: true, lower: 1.1000, upper: 1.2000, mid: 1.1500, widthPips: 1000, establishedUtc: established };
  const h4 = bars([[1.1050, 1.1010, 1.1020], [1.1030, 1.0990, 1.1010], [1.1060, 1.1020, 1.1040]]); // only a wick below → rejection, not failed
  const c = pick(detectFailedBreakout(ctxStub(h4, bal), CONFIG), 'BUY');
  assert.equal(c.state, 'NO_SETUP');
});

const { buildApproachFrame } = require('../../research/paw1h4/approaches');
const { H1_MS } = require('../../research/paw1h4/config');
function h1Osc(weeks) {
  const out = []; const S = Date.UTC(2025, 0, 6, 0, 0, 0);
  for (let w = 0; w < weeks; w++) for (let h = 0; h < 7 * 24; h++) { const lvl = 1.1100 + 0.006 * Math.sin(w * Math.PI / 2); const c = lvl + 0.001 * Math.sin((h / (7 * 24)) * 2 * Math.PI); const i = w * 7 * 24 + h; out.push({ openMs: S + i * H1_MS, closeMs: S + (i + 1) * H1_MS, open: c, high: c + 0.0003, low: c - 0.0003, close: c }); }
  return out;
}

test('buildApproachFrame is causal: appending future H1 does not change the as-of frame', () => {
  const base = h1Osc(22);
  const asOf = base[Math.floor(base.length * 0.8)].closeMs;
  const a = buildApproachFrame(base, 'EUR_USD', asOf, CONFIG);
  const future = []; const last = base[base.length - 1];
  for (let i = 0; i < 400; i++) { const c = 1.30 + 0.0005 * i; future.push({ openMs: last.closeMs + i * H1_MS, closeMs: last.closeMs + (i + 1) * H1_MS, open: c, high: c + 0.0003, low: c - 0.0003, close: c }); }
  const b = buildApproachFrame(base.concat(future), 'EUR_USD', asOf, CONFIG);
  assert.equal(JSON.stringify(a.context.balance), JSON.stringify(b.context.balance));
  assert.equal(JSON.stringify(a.candidates), JSON.stringify(b.candidates));
  assert.equal(a.markers.length, b.markers.length);
});

test('location gate: when price is INSIDE the range, balance-relative approaches are NO_SETUP', () => {
  const bal = { confirmed: true, lower: 1.1000, upper: 1.2000, mid: 1.1500, widthPips: 1000, establishedUtc: established };
  // a valid lower-rejection exists in the H4 history …
  const h4 = bars([[1.1050, 1.1010, 1.1020], [1.1030, 1.0990, 1.1010], [1.1060, 1.1020, 1.1040], [1.1080, 1.1030, 1.1060]]);
  // … but the CURRENT location is INSIDE (deep in the range)
  const ctx = ctxStub(h4, bal); ctx.location = { zone: 'INSIDE' };
  assert.equal(pick(detectRangeRejection(ctx, CONFIG), 'BUY').state, 'NO_SETUP');
  assert.equal(pick(detectAcceptedBreakout(ctx, CONFIG), 'BUY').state, 'NO_SETUP');
  assert.equal(pick(detectFailedBreakout(ctx, CONFIG), 'BUY').state, 'NO_SETUP');
  // at the boundary it is NOT gated out
  const ctx2 = ctxStub(h4, bal); ctx2.location = { zone: 'AT_LOWER' };
  assert.notEqual(pick(detectRangeRejection(ctx2, CONFIG), 'BUY').state, 'NO_SETUP');
});
