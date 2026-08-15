'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  signalKey, transitionIdempotencyKey, appendTransition, stateAt,
} = require('../../api/_lfe-persist');

test('signalKey is stable and setup-specific', () => {
  const a = signalKey('EUR_USD', 'SELL', '2026-08-14T09:00:00Z', '2026-08-14T11:00:00Z');
  const b = signalKey('EUR_USD', 'SELL', '2026-08-14T09:00:00Z', '2026-08-14T11:00:00Z');
  const c = signalKey('EUR_USD', 'BUY', '2026-08-14T09:00:00Z', '2026-08-14T11:00:00Z');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('transitionIdempotencyKey composes signal, target state and time', () => {
  const k = transitionIdempotencyKey('EUR_USD:SELL:L:F', 'MSS_PENDING', '2026-08-14T11:15:00Z');
  assert.equal(k, 'EUR_USD:SELL:L:F|MSS_PENDING|2026-08-14T11:15:00Z');
});

test('appendTransition is idempotent — re-running never duplicates', () => {
  const list = [];
  const tx = {
    signalKey: 'EUR_USD:SELL:L:F', toState: 'FAILURE_CONFIRMED',
    occurredAt: '2026-08-14T11:00:00Z', evaluationMs: 0,
  };
  const first = appendTransition(list, tx);
  const second = appendTransition(list, tx); // identical re-evaluation
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  assert.equal(list.length, 1);
});

test('appendTransition adds genuinely new transitions', () => {
  const list = [];
  appendTransition(list, { signalKey: 'S', toState: 'FAILURE_CONFIRMED', occurredAt: '2026-08-14T11:00:00Z' });
  appendTransition(list, { signalKey: 'S', toState: 'MSS_PENDING', occurredAt: '2026-08-14T11:15:00Z' });
  appendTransition(list, { signalKey: 'S', toState: 'SIGNAL_CONFIRMED', occurredAt: '2026-08-14T11:30:00Z' });
  assert.equal(list.length, 3);
});

test('stateAt replays the state as-it-was, never looking ahead', () => {
  const list = [];
  appendTransition(list, { signalKey: 'S', toState: 'FAILURE_CONFIRMED', occurredAt: '2026-08-14T11:00:00Z' });
  appendTransition(list, { signalKey: 'S', toState: 'MSS_PENDING', occurredAt: '2026-08-14T11:15:00Z' });
  appendTransition(list, { signalKey: 'S', toState: 'SIGNAL_CONFIRMED', occurredAt: '2026-08-14T11:30:00Z' });

  assert.equal(stateAt(list, '2026-08-14T10:00:00Z'), null);              // before anything
  assert.equal(stateAt(list, '2026-08-14T11:05:00Z'), 'FAILURE_CONFIRMED');
  assert.equal(stateAt(list, '2026-08-14T11:20:00Z'), 'MSS_PENDING');
  assert.equal(stateAt(list, '2026-08-14T12:00:00Z'), 'SIGNAL_CONFIRMED'); // latest ≤ eval
});
