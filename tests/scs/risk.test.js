'use strict';

const test = require('node:test');
const assert = require('node:assert');
const risk = require('../../api/_scs-risk');

const cand = { direction: 'BUY' };
const ctxBase = { pair: 'EUR_USD', direction: 'BUY', openPositions: [], spread: 0.00008, normalSpread: 0.0001, riskPct: 0.25, ms: 0 };

test('clean admit uses default risk and flags news unavailable (no provider)', () => {
  const r = risk.admit(cand, { ...ctxBase, newsFilter: risk.makeNewsFilter(null) });
  assert.equal(r.admit, true);
  assert.equal(r.riskPct, 0.25);
  assert.equal(r.newsUnavailable, true);
});

test('risk % is clamped to the validated maximum', () => {
  assert.equal(risk.positionSizePct(0.9), 0.5);
  assert.equal(risk.positionSizePct(undefined), 0.25);
});

test('two open positions → MAX_POSITIONS', () => {
  const open = [{ pair: 'GBP_JPY', direction: 'BUY', riskPct: 0.25 }, { pair: 'AUD_CAD', direction: 'SELL', riskPct: 0.25 }];
  assert.equal(risk.admit(cand, { ...ctxBase, openPositions: open }).rejection, 'MAX_POSITIONS');
});

test('combined open risk above 1% → MAX_OPEN_RISK', () => {
  const open = [{ pair: 'GBP_JPY', direction: 'BUY', riskPct: 0.9 }];
  assert.equal(risk.admit(cand, { ...ctxBase, openPositions: open }).rejection, 'MAX_OPEN_RISK');
});

test('same-currency same-direction → CORRELATED_EXPOSURE', () => {
  const open = [{ pair: 'EUR_JPY', direction: 'BUY', riskPct: 0.25 }]; // EUR long
  assert.equal(risk.admit(cand, { ...ctxBase, pair: 'EUR_GBP', openPositions: open }).rejection, 'CORRELATED_EXPOSURE');
  // opposite EUR usage is not correlated
  const open2 = [{ pair: 'GBP_JPY', direction: 'BUY', riskPct: 0.25 }];
  assert.equal(risk.admit(cand, { ...ctxBase, pair: 'EUR_USD', openPositions: open2 }).admit, true);
});

test('spread beyond 2× normal → SPREAD_TOO_WIDE', () => {
  assert.equal(risk.admit(cand, { ...ctxBase, spread: 0.0003, normalSpread: 0.0001 }).rejection, 'SPREAD_TOO_WIDE');
});

test('news provider blocking → HIGH_IMPACT_NEWS; unavailable never blocks', () => {
  const blocked = risk.makeNewsFilter({ check: () => ({ blocked: true }) });
  assert.equal(risk.admit(cand, { ...ctxBase, newsFilter: blocked }).rejection, 'HIGH_IMPACT_NEWS');
  const nf = risk.makeNewsFilter(null);
  assert.equal(nf.check('EUR_USD', 0).reason, 'NEWS_FILTER_UNAVAILABLE');
  assert.equal(nf.check('EUR_USD', 0).blocked, false);
});
