'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { episodeId, tagIndependence, independentCount, inForwardWindow, FORWARD } = require('../../api/_m15/forward');
const { notifiable, selectNewNotifications } = require('../../api/_m15/notify');

const M15 = 15 * 60 * 1000;
const T = Date.UTC(2026, 8, 10, 12, 0, 0);

test('episodeId is stable across candles and sensitive to version', () => {
  const a = episodeId('EUR_USD', 'BULLISH', T, 'm15-cfg-1.1.0a+h');
  const b = episodeId('EUR_USD', 'BULLISH', T, 'm15-cfg-1.1.0a+h');
  const c = episodeId('EUR_USD', 'BULLISH', T, 'm15-cfg-1.0.0+h');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('correlated overlapping episodes are NOT counted as independent', () => {
  // EUR_USD and EUR_GBP overlap in time and share EUR ⇒ correlated
  const eps = [
    { id: 'e1', pair: 'EUR_USD', direction: 'BULLISH', firstMs: T, lastMs: T + 2 * M15 },
    { id: 'e2', pair: 'EUR_GBP', direction: 'BULLISH', firstMs: T + M15, lastMs: T + 3 * M15 },
    { id: 'e3', pair: 'AUD_NZD', direction: 'BEARISH', firstMs: T + M15, lastMs: T + 2 * M15 }, // no shared ccy
  ];
  const tagged = tagIndependence(eps);
  assert.equal(tagged.find((e) => e.id === 'e1').independent, true);
  assert.equal(tagged.find((e) => e.id === 'e2').independent, false);       // shares EUR with e1
  assert.deepEqual(tagged.find((e) => e.id === 'e2').correlatedWith, ['e1']);
  assert.equal(tagged.find((e) => e.id === 'e3').independent, true);
  assert.equal(independentCount(eps), 2);                                    // e1 + e3
});

test('non-overlapping same-currency episodes ARE independent', () => {
  const eps = [
    { id: 'e1', pair: 'EUR_USD', direction: 'BULLISH', firstMs: T, lastMs: T + M15 },
    { id: 'e2', pair: 'EUR_GBP', direction: 'BULLISH', firstMs: T + 10 * M15, lastMs: T + 11 * M15 },
  ];
  assert.equal(independentCount(eps), 2);
});

test('forward window is closed until the owner sets a start', () => {
  assert.equal(FORWARD.observationStartMs, null);       // not set in test env
  assert.equal(inForwardWindow(T), false);
});

test('notifiable: only live + complete + fresh', () => {
  assert.equal(notifiable({ historyMode: true, complete: true, stale: false }).ok, false);
  assert.equal(notifiable({ historyMode: false, complete: false, stale: false }).reason, 'INCOMPLETE');
  assert.equal(notifiable({ historyMode: false, complete: true, stale: true }).reason, 'STALE');
  assert.equal(notifiable({ historyMode: false, complete: true, stale: false }).ok, true);
});

test('replay / incomplete / stale never emit notifications', () => {
  const eps = [{ episodeId: 'x', pair: 'EUR_USD', direction: 'BULLISH', firstCloseMs: T }];
  assert.deepEqual(selectNewNotifications({ historyMode: true, complete: true, stale: false }, eps).emit, []);
  assert.equal(selectNewNotifications({ historyMode: true, complete: true, stale: false }, eps).suppressed, 'REPLAY');
  assert.deepEqual(selectNewNotifications({ historyMode: false, complete: false, stale: false }, eps).emit, []);
  assert.deepEqual(selectNewNotifications({ historyMode: false, complete: true, stale: true }, eps).emit, []);
});

test('new actionable episodes emit once; already-notified are deduped', () => {
  const ctx = { historyMode: false, complete: true, stale: false, engineVersion: 'm15-cfg-1.1.0a+h', closeMs: T };
  const eps = [
    { episodeId: 'a', pair: 'EUR_USD', direction: 'BULLISH', firstCloseMs: T },
    { episodeId: 'b', pair: 'GBP_JPY', direction: 'BEARISH', firstCloseMs: T },
  ];
  const first = selectNewNotifications(ctx, eps, new Set());
  assert.equal(first.emit.length, 2);
  assert.equal(first.emit[0].kind, 'MANUAL_REVIEW_OPPORTUNITY');
  assert.match(first.emit[0].note, /not an instruction or order/);
  // next candle, both already notified ⇒ none re-emitted
  const second = selectNewNotifications(ctx, eps, new Set(['a', 'b']));
  assert.equal(second.emit.length, 0);
});
