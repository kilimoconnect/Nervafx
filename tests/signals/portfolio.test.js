'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { simulate } = require('../../research/signals/portfolio');
const { strategyStats, byPeriod, byPair, byDirection } = require('../../research/signals/stats');

const params = { initialEquity: 100000, riskPerTradePct: 0.5, maxAggregateRiskPct: 2.0, maxPerCurrencyRiskPct: 1.0 };

function tr(pair, dir, fillMs, exitMs, netR, rank = 1, strat = 'today', status = 'CLOSED') {
  return { status, fillMs, exitMs, netR, result: netR > 0 ? 'win' : (netR < 0 ? 'loss' : 'breakeven'),
    ambiguityFlag: false, dataQuality: { monitorTf: 'M15' }, signal: { pair, direction: dir, rank, strategyKey: strat } };
}

test('independent portfolio compounds risk% × netR per closed trade', () => {
  const trades = [tr('EUR_USD', 'BUY', 0, 10, 1), tr('GBP_USD', 'SELL', 20, 30, -1), tr('AUD_USD', 'BUY', 40, 50, 2)];
  const r = simulate(trades, params);
  // 100000 → ×(1+.005) → 100500 → −.005·100500 → 99997.5 → +.01·99997.5 → 100997.475
  assert.ok(Math.abs(r.finalEquity - 100997.48) < 0.02, 'final equity ' + r.finalEquity);
  assert.ok(Math.abs(r.accountReturnPct - 0.997) < 0.01);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.closed, 3);
});

test('account return is NOT the win rate; drawdown is captured on the losing leg', () => {
  const trades = [tr('EUR_USD', 'BUY', 0, 10, 1), tr('GBP_USD', 'SELL', 20, 30, -1)];
  const r = simulate(trades, params);
  assert.ok(r.maxDrawdownPct > 0, 'drawdown recorded after the −1R trade');
});

test('combined: aggregate open-risk limit caps concurrency at 2% (4 × 0.5%)', () => {
  // five fully-overlapping trades, distinct pairs
  const trades = [
    tr('EUR_USD', 'BUY', 0, 100, 1, 1), tr('GBP_JPY', 'BUY', 0, 100, 1, 2),
    tr('AUD_CHF', 'BUY', 0, 100, 1, 3), tr('NZD_CAD', 'BUY', 0, 100, 1, 4),
    tr('EUR_GBP', 'BUY', 0, 100, 1, 5),
  ];
  const r = simulate(trades, params, { combined: true });
  assert.equal(r.skipped.length, 1, 'the 5th concurrent trade is skipped');
  assert.ok(/aggregate/.test(r.skipped[0].reason));
});

test('combined: a second position in an already-open pair is skipped', () => {
  const trades = [tr('EUR_USD', 'BUY', 0, 100, 1, 1), tr('EUR_USD', 'BUY', 10, 50, 1, 2, 'week')];
  const r = simulate(trades, params, { combined: true });
  assert.equal(r.skipped.length, 1);
  assert.ok(/already open/.test(r.skipped[0].reason));
});

test('combined: simultaneous opposite-direction signals on the same pair skip BOTH', () => {
  const trades = [tr('EUR_USD', 'BUY', 0, 100, 1, 1, 'today'), tr('EUR_USD', 'SELL', 0, 100, 1, 1, 'week')];
  const r = simulate(trades, params, { combined: true });
  assert.equal(r.skipped.length, 2, 'both sides skipped and recorded');
  assert.ok(r.skipped.every((s) => /opposite-direction/.test(s.reason)));
});

test('strategyStats: win-rate denominator excludes non-resolved; profit factor + avg hold', () => {
  const entryMs = 15 * 60 * 1000;
  const trades = [
    tr('EUR_USD', 'BUY', 0, 2 * entryMs, 2),       // win, 2 candles
    tr('GBP_USD', 'SELL', 0, 4 * entryMs, -1),     // loss, 4 candles
    Object.assign(tr('AUD_USD', 'BUY', 0, 0, 0), { status: 'CANCELLED' }),
    Object.assign(tr('NZD_USD', 'BUY', 0, 0, 0), { status: 'OPEN' }),
  ];
  const s = strategyStats(trades, entryMs);
  assert.equal(s.closed, 2); assert.equal(s.cancelled, 1); assert.equal(s.open, 1);
  assert.equal(s.resolvedClosed, 2); assert.equal(s.winRate, 50);
  assert.ok(Math.abs(s.profitFactor - 2) < 1e-9, 'PF = 2R win / 1R loss');
  assert.equal(s.avgHoldCandles, 3);
});

test('byPeriod attributes a closed trade to its EXIT period', () => {
  const exitMs = Date.UTC(2025, 5, 15, 12, 0, 0);
  const s = byPeriod([tr('EUR_USD', 'BUY', exitMs - 3600000, exitMs, 1)], 'monthly');
  assert.equal(s[0].period, '2025-06');
  assert.equal(s[0].closed, 1);
});

test('byPair / byDirection breakdowns sum net R per bucket', () => {
  const trades = [tr('EUR_USD', 'BUY', 0, 1, 2), tr('EUR_USD', 'BUY', 2, 3, -1), tr('GBP_USD', 'SELL', 0, 1, 1)];
  const bp = byPair(trades); const bd = byDirection(trades);
  assert.equal(bp.find((x) => x.key === 'EUR_USD').closed, 2);
  assert.equal(bd.find((x) => x.key === 'BUY').closed, 2);
});
