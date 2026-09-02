'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildHistoryView, buildScanCard, snapToCompletedH1 } = require('../../api/_scs-history');
const { runCoordinator } = require('../../api/_scs-coordinator');

const H1 = 3600000;
function week(startMs, hours) { const a = []; for (let i = 0; i < hours; i++) a.push({ openMs: startMs + i * H1, open: 1.10, high: 1.1010, low: 1.099, close: 1.10 }); return a; }
const START = Date.UTC(2026, 6, 19, 21, 0);       // Sun 17:00 NY reopen (Monday session)
const h1raw = week(START, 120);                    // full EDT week

test('non-boundary time auto-corrects to the latest completed H1 close; orders disabled', () => {
  const at = Date.UTC(2026, 6, 22, 12, 30);        // 12:30 → not a boundary
  const v = buildHistoryView({ h1raw, pair: 'EUR_USD', at });
  assert.equal(v.autoCorrected, true);
  assert.equal(v.evalMs, snapToCompletedH1(at));
  assert.equal(v.ordersDisabled, true);
});

test('no future candles rendered (all charts truncated to the selected time)', () => {
  const at = Date.UTC(2026, 6, 22, 12, 0);
  const v = buildHistoryView({ h1raw, pair: 'EUR_USD', at });
  for (const c of v.h1.candles) assert.ok(c.openMs + H1 <= v.evalMs);
  for (const c of v.d1.candles) assert.ok((c.endMs || c.openMs) <= v.evalMs);
  for (const c of v.h4.candles) assert.ok((c.endMs || c.openMs) <= v.evalMs);
});

test('no future swings rendered (only swings confirmed as of the selected time)', () => {
  const at = Date.UTC(2026, 6, 22, 12, 0);
  const v = buildHistoryView({ h1raw, pair: 'EUR_USD', at });
  for (const s of v.h1.swings) assert.ok(s.openMs + 3 * H1 <= v.evalMs); // 2 right H1 candles must have closed
});

test('Why-No-Trade reports the exact waiting/rejection reason', () => {
  const v = buildHistoryView({ h1raw, pair: 'EUR_USD', at: Date.UTC(2026, 6, 22, 12, 0) });
  assert.ok(v.whyNoTrade && v.whyNoTrade.code && v.whyNoTrade.text);
  assert.equal(v.whyNoTrade.code, 'D1_NEUTRAL');   // flat data → no D1 direction
});

test('weekend selection shows Friday final state banner', () => {
  const v = buildHistoryView({ h1raw, pair: 'EUR_USD', at: Date.UTC(2026, 6, 25, 12, 0) }); // Saturday
  assert.equal(v.marketState, 'WEEKEND_FROZEN');
  assert.ok(v.weekend && v.weekend.closed);
  assert.match(v.weekend.message, /MARKET CLOSED/);
  assert.ok(v.weekend.mondayReopenUtc);
});

test('scan card summarizes a pair with stage/rank and never leaks future data', () => {
  const at = Date.UTC(2026, 6, 22, 12, 30);
  const c = buildScanCard({ h1raw, pair: 'EUR_USD', at });
  assert.equal(c.pair, 'EUR_USD');
  assert.equal(c.evalMs, snapToCompletedH1(at));
  assert.ok(['SIGNAL', 'H1_REJECTION', 'H4_PULLBACK', 'H4_IMPULSE', 'D1_ALIGNED', 'NEUTRAL'].includes(c.stage));
  // qualifying requires a confirmed H1 BOS signal, never a rejection/pullback alone
  assert.equal(c.qualifies, c.stage === 'SIGNAL');
  assert.equal(typeof c.qualifies, 'boolean');
  // flat data → neutral, not qualifying, with a why-no-trade reason
  assert.equal(c.stage, 'NEUTRAL');
  assert.equal(c.qualifies, false);
  assert.ok(c.whyNoTrade && c.whyNoTrade.code);
});

test('live / history parity: same candle input → identical coordinator state', () => {
  const at = Date.UTC(2026, 6, 22, 12, 0);
  const evalMs = snapToCompletedH1(at);
  const live = runCoordinator({ h1raw, evalMs, pair: 'EUR_USD' });
  const hist = buildHistoryView({ h1raw, pair: 'EUR_USD', at });
  assert.equal(hist.d1.direction, live.d1.direction);
  assert.equal(hist.h4.state, live.h4.state);
  assert.equal(hist.h1.state, live.h1.state);
});
