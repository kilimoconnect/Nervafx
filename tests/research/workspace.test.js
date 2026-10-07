'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gen = require('../../scripts/research/build-workspace-fixtures');

const payload = gen.build();
const byPair = Object.fromEntries(payload.watchlist.map((w) => [w.pair, w]));
const allFrames = payload.watchlist.flatMap((w) => w.frames);

test('workspace fixtures carry the required contract fields per frame', () => {
  for (const w of payload.watchlist) {
    assert.ok(Array.isArray(w.candles) && Array.isArray(w.frames) && w.frames.length >= 1, w.pair);
    for (const f of w.frames) {
      for (const k of ['asOfCloseUtc', 'asOfCloseEat', 'primaryState', 'windows', 'priceStories', 'dataHealth', 'nextCondition']) assert.ok(k in f, `${w.pair} missing ${k}`);
      assert.ok(f.priceStories.h12 !== undefined && 'h48' in f.priceStories);
    }
  }
});

test('causality: no frame shows an event dated after its own close', () => {
  for (const f of allFrames) for (const e of (f.events || [])) assert.ok(e.ms <= f.asOfCloseMs, `${f.asOfCloseUtc} has event ${e.utc}`);
});

test('causality: the current leg is provisional (no backdated pivot)', () => {
  for (const f of allFrames) if (f.structure && f.structure.provisionalLeg) assert.equal(f.structure.provisionalLeg.confirmed, false);
});

test('scenarios exercise the key states', () => {
  const last = (p) => byPair[p].frames[byPair[p].frames.length - 1].primaryState;
  assert.equal(last('EUR_GBP'), 'ACCEPTED_TREND_DOWN');
  assert.equal(last('EUR_USD'), 'CONFLICT');
  assert.equal(last('AUD_JPY'), 'ACCEPTED_TREND_UP');
  assert.equal(last('NZD_CAD'), 'UNAVAILABLE');
  const gbpaud = new Set(byPair['GBP_AUD'].frames.map((f) => f.primaryState));
  assert.ok(gbpaud.has('REVERSAL_UP'));
  assert.ok(gbpaud.has('EMERGING_MOVE_DOWN'));
});

test('data-health states are represented (unavailable, closed-market, extended)', () => {
  assert.equal(byPair['NZD_CAD'].frames[0].dataHealth.available, false);
  assert.ok(byPair['GBP_NZD'].frames.some((f) => f.dataHealth.closedMarket));
  assert.ok(byPair['AUD_JPY'].frames.some((f) => f.extendedMove));
});

test('other-pair confirmation is labelled as such, not as independence', () => {
  const f = byPair['EUR_GBP'].frames.find((x) => x.otherPairConfirmation);
  assert.ok(f && /OTHER-PAIR/.test(f.otherPairConfirmation.note));
  assert.ok(/not statistical independence/i.test(f.otherPairConfirmation.note));
});

test('model health preserves NONE PASSED and shows no profitability/confidence field', () => {
  assert.equal(payload.modelHealth.status, 'UNVALIDATED');
  assert.equal(payload.modelHealth.stage5.decision, 'NONE PASSED');
  for (const v of Object.values(payload.modelHealth.infocontent.verdicts)) assert.equal(v, 'INSUFFICIENT_EVIDENCE');
  // No fabricated performance METRICS anywhere (keys/values), though disclaimers may
  // legitimately say "no profitability ...". Check for metric-shaped keys/numbers.
  const blob = JSON.stringify(payload).toLowerCase();
  assert.ok(!/"winrate"|"win_rate"|"sharpe"|"expectedreturn"|"pnl"|"edge":\s*-?\d|"confidence":\s*-?\d|"probability":\s*-?\d/.test(blob));
  assert.ok(/synthetic/i.test(payload.meta.provenance + payload.meta.disclaimer));
});

test('nextCondition/invalidation present for available frames', () => {
  for (const f of allFrames) if (f.dataHealth.available) assert.ok(typeof f.nextCondition === 'string' && f.nextCondition.length > 0);
});
