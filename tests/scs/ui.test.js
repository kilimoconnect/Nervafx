'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ui = require('../../api/_scs-ui');

const H1 = 3600000;

test('History Mode disables all order actions', () => {
  assert.equal(ui.ordersDisabled('HISTORY'), true);
  assert.equal(ui.ordersDisabled('LIVE'), false);
});

test('selected time snaps to the latest completed H1 close', () => {
  const at = Date.UTC(2026, 6, 22, 12, 37);
  assert.equal(ui.snapSelectedToCompletedH1(at), Date.UTC(2026, 6, 22, 12, 0));
});

test('Prev/Next H1 step by one completed candle', () => {
  const at = Date.UTC(2026, 6, 22, 12, 0);
  assert.equal(ui.stepH1(at, 1), at + H1);
  assert.equal(ui.stepH1(at, -1), at - H1);
});

test('playback speed maps 1x/2x/4x to intervals', () => {
  assert.equal(ui.playbackIntervalMs(1, 1000), 1000);
  assert.equal(ui.playbackIntervalMs(2, 1000), 500);
  assert.equal(ui.playbackIntervalMs(4, 1000), 250);
  assert.equal(ui.playbackIntervalMs(3, 1000), 1000); // unknown → 1x
});

test('weekend navigation targets come from the view', () => {
  assert.equal(ui.weekendTargets({ weekend: null }), null);
  const t = ui.weekendTargets({ weekend: { closed: true, fridayCloseUtc: 'F', mondayReopenUtc: 'M' } });
  assert.deepEqual(t, { fridayClose: 'F', mondayReopen: 'M' });
});

test('URL builders encode replay and backtest requests', () => {
  assert.match(ui.replayUrl('EUR_USD', Date.UTC(2026, 6, 22, 12, 0), 'Africa/Dar_es_Salaam'), /pair=EUR_USD&at=.*&timezone=Africa/);
  const u = ui.backtestUrl('EUR_USD', Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1), { direction: 'BUY', origin: 'FRIDAY_CARRY' });
  assert.match(u, /mode=backtest/); assert.match(u, /direction=BUY/); assert.match(u, /origin=FRIDAY_CARRY/);
});
