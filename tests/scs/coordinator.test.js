'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runCoordinator, marketState, revalidateMonday } = require('../../api/_scs-coordinator');

const H1 = 3600000;
function week(startMs, hours) { const a = []; for (let i = 0; i < hours; i++) a.push({ openMs: startMs + i * H1, open: 1.10, high: 1.1010, low: 1.099, close: 1.10 }); return a; }

test('marketState classifies weekend / Friday cutoff / Monday revalidation / normal', () => {
  assert.equal(marketState(Date.UTC(2026, 6, 25, 12, 0)), 'WEEKEND_FROZEN');           // Saturday
  assert.equal(marketState(Date.UTC(2026, 6, 24, 20, 0)), 'FRIDAY_CUTOFF');            // 1h before Fri 17:00 NY
  assert.equal(marketState(Date.UTC(2026, 6, 19, 22, 0)), 'MONDAY_REVALIDATION');      // first completed H1 of Monday session
  assert.equal(marketState(Date.UTC(2026, 6, 21, 12, 0)), 'NORMAL');                   // Tuesday midday
});

test('coordinator runs D1→H4→H1 in order and returns full evidence', () => {
  const r = runCoordinator({ h1raw: week(Date.UTC(2026, 6, 19, 21, 0), 120), evalMs: Date.UTC(2026, 6, 22, 12, 0), pair: 'EUR_USD' });
  assert.deepEqual(r.evaluationOrder, ['D1', 'H4', 'H1']);
  assert.ok(r.d1 && r.h4 && r.h1);
  assert.equal(r.marketState, 'NORMAL');
  assert.equal(r.evidence.pair, 'EUR_USD');
});

test('weekend evaluation is frozen (no new signals)', () => {
  const r = runCoordinator({ h1raw: week(Date.UTC(2026, 6, 19, 21, 0), 120), evalMs: Date.UTC(2026, 6, 25, 12, 0), pair: 'EUR_USD' });
  assert.equal(r.marketState, 'WEEKEND_FROZEN');
  assert.equal(r.h1.status, 'FROZEN');
  assert.equal(r.h1.rejection, 'WEEKEND_FROZEN');
});

test('deterministic: identical inputs reproduce identical output (restart recovery)', () => {
  const inp = { h1raw: week(Date.UTC(2026, 6, 19, 21, 0), 120), evalMs: Date.UTC(2026, 6, 22, 12, 0), pair: 'EUR_USD' };
  assert.deepEqual(JSON.parse(JSON.stringify(runCoordinator(inp))), JSON.parse(JSON.stringify(runCoordinator(inp))));
});

test('Monday revalidation: active trade keeps original stop/target; gap through target fills at open with slippage', () => {
  const frozen = { state: 'ACTIVE', status: 'ACTIVE', candidate: { direction: 'BUY', entry: 1.1012, stop: 1.0985, target: 1.1063 } };
  const r = revalidateMonday(frozen, 1.1070);   // gapped above target
  assert.equal(r.status, 'TARGET_HIT');
  assert.ok(Math.abs(r.slippage - 0.0007) < 1e-9);
  const r2 = revalidateMonday(frozen, 1.0980);  // gapped below stop
  assert.equal(r2.status, 'STOP_HIT');
});

test('Monday revalidation: pending gapped past the setup → MONDAY_GAP_INVALIDATED', () => {
  const frozen = { state: 'ENTRY_PENDING', status: 'PENDING', candidate: { direction: 'BUY', entry: 1.1012, stop: 1.0985, target: 1.1063 } };
  assert.equal(revalidateMonday(frozen, 1.0970).rejection, 'MONDAY_GAP_INVALIDATED'); // below stop
  assert.equal(revalidateMonday(frozen, 1.1030).revalidated, true);                    // inside → survives
  assert.equal(revalidateMonday(frozen, 1.1030).rejection, undefined);
});
