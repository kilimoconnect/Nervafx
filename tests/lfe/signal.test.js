'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyEma, rotationScore, scoreComponents, gradeOf, computeRisk, buildSignal, applyCorrelationFilter,
} = require('../../api/_lfe-signal');
const { SIGNAL_CLASS, SIGNAL_GRADE, MSS_STATUS, M15_MS } = require('../../api/_lfe-constants');

// ── D. EMA classification ───────────────────────────────────────────────────
test('EMA classifies trend-aligned and countertrend correctly', () => {
  assert.equal(classifyEma('BUY', 1.11, 1.10, null).classification, SIGNAL_CLASS.TREND_ALIGNED);
  assert.equal(classifyEma('SELL', 1.10, 1.11, null).classification, SIGNAL_CLASS.TREND_ALIGNED);
  const ctSell = classifyEma('SELL', 1.11, 1.10, 1.105); // failure closed below EMA20 1.11
  assert.equal(ctSell.classification, SIGNAL_CLASS.COUNTERTREND);
  assert.equal(ctSell.throughEma20, true);
  const ctBuy = classifyEma('BUY', 1.10, 1.11, 1.105); // failure closed above EMA20 1.10
  assert.equal(ctBuy.classification, SIGNAL_CLASS.COUNTERTREND);
  assert.equal(ctBuy.throughEma20, true);
});

// ── E. Currency rotation ────────────────────────────────────────────────────
test('rotation favours BUY on positive pairRotation, SELL on negative', () => {
  const buy = rotationScore('BUY', { baseDelta: 1.5, quoteDelta: -0.5 });
  assert.equal(buy.pairRotation, 2.0);
  assert.equal(buy.score, 1);
  const sellWrong = rotationScore('SELL', { baseDelta: 1.5, quoteDelta: -0.5 });
  assert.equal(sellWrong.score, 0); // positive rotation is unfavourable for SELL
  assert.equal(rotationScore('BUY', null).score, 0);
});

// ── F. Score boundaries & classification gate ───────────────────────────────
test('a strong trend-aligned confirmed setup scores 85 (A+)', () => {
  const event = { levelScore: 15, qualityPoints: 14, eventKey: 'k', pair: 'EUR_USD', direction: 'SELL' };
  const conf = { status: MSS_STATUS.CONFIRMED };
  const ema = { classification: SIGNAL_CLASS.TREND_ALIGNED, throughEma20: false };
  const c = scoreComponents(event, conf, ema, { score: 0 }, { contextPoints: 0 });
  assert.equal(c.total, 85);
  assert.equal(gradeOf(c.total, SIGNAL_CLASS.TREND_ALIGNED), SIGNAL_GRADE.APLUS);
});

test('grade thresholds and the countertrend ≥85 rule', () => {
  assert.equal(gradeOf(90, SIGNAL_CLASS.TREND_ALIGNED), SIGNAL_GRADE.APLUS);
  assert.equal(gradeOf(80, SIGNAL_CLASS.TREND_ALIGNED), SIGNAL_GRADE.CONFIRMED);
  assert.equal(gradeOf(70, SIGNAL_CLASS.TREND_ALIGNED), SIGNAL_GRADE.WATCH);
  assert.equal(gradeOf(60, SIGNAL_CLASS.TREND_ALIGNED), SIGNAL_GRADE.REJECTED);
  // Countertrend below 85 is rejected even though it would otherwise be CONFIRMED.
  assert.equal(gradeOf(80, SIGNAL_CLASS.COUNTERTREND), SIGNAL_GRADE.REJECTED);
  assert.equal(gradeOf(88, SIGNAL_CLASS.COUNTERTREND), SIGNAL_GRADE.APLUS);
});

// ── G. Risk ─────────────────────────────────────────────────────────────────
const riskEvent = { direction: 'SELL', sweepExtreme: 1.10030, h1Atr: 0.0010 };

test('SELL risk: stop above the sweep, 2R default target, reward gate', () => {
  const conf = { confirmClose: 1.09950, confirmAtMs: 0 };
  const r = computeRisk(riskEvent, conf, { nextOpen: 1.09950 });
  assert.equal(r.ok, true);
  assert.equal(r.stop, 1.10040);             // 1.10030 + 0.10*ATR(0.0001)
  assert.ok(Math.abs(r.risk - 0.0009) < 1e-9);
  assert.equal(r.rewardR, 2);
  assert.equal(r.rewardOK, true);
});

test('reward gate rejects when the opposing level is closer than 1.5R', () => {
  const conf = { confirmClose: 1.09950, confirmAtMs: 0 };
  const r = computeRisk(riskEvent, conf, { nextOpen: 1.09950, opposingLevel: 1.09900 });
  assert.ok(r.rewardR < 1.5);
  assert.equal(r.rewardOK, false);
});

test('late and entry-expiry flags', () => {
  const conf = { confirmClose: 1.09950, confirmAtMs: 0 };
  const r = computeRisk(riskEvent, conf, { nextOpen: 1.09950, currentPrice: 1.09900, evalMs: 5 * M15_MS });
  assert.equal(r.late, true);         // moved 0.0005 > 0.5*risk (0.00045)
  assert.equal(r.entryExpired, true); // evalMs beyond confirm + 4 M15
});

// ── Signal assembly & mandatory gate ────────────────────────────────────────
test('buildSignal keeps an unconfirmed event visible but not tradable', () => {
  const event = { eventKey: 'k', pair: 'EUR_USD', direction: 'SELL', levelScore: 12, qualityPoints: 10 };
  const s = buildSignal(event, { status: MSS_STATUS.WAITING }, {});
  assert.equal(s.isSignal, false);
  assert.equal(s.reason, MSS_STATUS.WAITING);
});

test('buildSignal produces a tradable trend-aligned signal end-to-end', () => {
  const event = {
    eventKey: 'k', pair: 'EUR_USD', direction: 'SELL', failedSide: 'BUYERS', setupType: 'IMMEDIATE',
    levelScore: 15, qualityPoints: 14, sweepExtreme: 1.10030, h1Atr: 0.0010,
  };
  const conf = { status: MSS_STATUS.CONFIRMED, breakLevel: 1.09950, confirmClose: 1.09950, confirmAtMs: 0 };
  const ctx = { ema20: 1.098, ema50: 1.099, nextOpen: 1.09950, evalMs: 0, rotation: { baseDelta: -1, quoteDelta: 1 } };
  const s = buildSignal(event, conf, ctx);
  assert.equal(s.isSignal, true);
  assert.equal(s.classification, SIGNAL_CLASS.TREND_ALIGNED);
  assert.ok(s.grade === SIGNAL_GRADE.APLUS || s.grade === SIGNAL_GRADE.CONFIRMED);
  assert.ok(s.risk.ok && s.risk.rewardOK);
});

// ── H. Correlation filter ───────────────────────────────────────────────────
test('correlated same-currency positions are grouped, strongest preferred', () => {
  const signals = [
    { pair: 'EUR_USD', direction: 'BUY', score: { total: 80 } },
    { pair: 'EUR_GBP', direction: 'BUY', score: { total: 70 } }, // shares EUR+ with EUR_USD
    { pair: 'GBP_JPY', direction: 'BUY', score: { total: 90 } }, // independent exposure
  ];
  const out = applyCorrelationFilter(signals);
  const eurUsd = out.find((s) => s.pair === 'EUR_USD');
  const eurGbp = out.find((s) => s.pair === 'EUR_GBP');
  const gbpJpy = out.find((s) => s.pair === 'GBP_JPY');
  assert.equal(eurUsd.preferred, true);
  assert.equal(eurUsd.correlated, false);
  assert.equal(eurGbp.preferred, false);
  assert.equal(eurGbp.correlated, true);          // labelled, not deleted
  assert.equal(eurGbp.correlationGroup, eurUsd.correlationGroup);
  assert.equal(gbpJpy.preferred, true);
  assert.equal(gbpJpy.correlated, false);
});
