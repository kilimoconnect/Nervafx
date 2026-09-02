'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildHistoryView, snapToCompletedH1 } = require('../../api/_scs-history');
const { runCoordinator } = require('../../api/_scs-coordinator');
const { stepH1 } = require('../../api/_scs-ui');

const H1 = 3600000;
function week(startMs, hours) { const a = []; for (let i = 0; i < hours; i++) a.push({ openMs: startMs + i * H1, open: 1.10, high: 1.1010, low: 1.099, close: 1.10 }); return a; }
const START = Date.UTC(2026, 6, 19, 21, 0);
const h1raw = week(START, 120);

test('end-to-end replay: stepping H1 never reveals future candles and stays in live parity', () => {
  let at = Date.UTC(2026, 6, 21, 8, 0);
  let prevCount = -1;
  for (let i = 0; i < 8; i++) {
    const v = buildHistoryView({ h1raw, pair: 'EUR_USD', at });
    // no future candle at any step
    for (const c of v.h1.candles) assert.ok(c.openMs + H1 <= v.evalMs, 'future H1 candle leaked at step ' + i);
    // candle count is non-decreasing as time advances (monotonic reveal)
    assert.ok(v.h1.candles.length >= prevCount, 'candle count went backwards');
    prevCount = v.h1.candles.length;
    // parity with the live coordinator on the same snapped time
    const live = runCoordinator({ h1raw, evalMs: snapToCompletedH1(at), pair: 'EUR_USD' });
    assert.equal(v.h1.state, live.h1.state);
    assert.equal(v.d1.direction, live.d1.direction);
    at = stepH1(at, 1);
  }
});

test('Friday → weekend → Monday replay transitions correctly', () => {
  const wk1 = week(START, 120);                        // Sun 07-19 21:00 → Fri 07-24 21:00
  const wk2 = week(Date.UTC(2026, 6, 26, 21, 0), 6);   // following Monday session reopen
  const h1 = [...wk1, ...wk2];
  const friday = buildHistoryView({ h1raw: h1, pair: 'EUR_USD', at: Date.UTC(2026, 6, 24, 20, 0) });   // final 4h before Fri close
  assert.equal(friday.marketState, 'FRIDAY_CUTOFF');
  const sat = buildHistoryView({ h1raw: h1, pair: 'EUR_USD', at: Date.UTC(2026, 6, 25, 12, 0) });        // Saturday
  assert.equal(sat.marketState, 'WEEKEND_FROZEN');
  assert.match(sat.weekend.message, /MARKET CLOSED/);
  const mon = buildHistoryView({ h1raw: h1, pair: 'EUR_USD', at: Date.UTC(2026, 6, 26, 22, 0) });        // first completed Monday H1
  assert.equal(mon.marketState, 'MONDAY_REVALIDATION');
  assert.equal(mon.ordersDisabled, true);
});

test('backtest parity: a replay step and a backtest over that instant see identical structure', () => {
  const at = Date.UTC(2026, 6, 22, 12, 0);
  const evalMs = snapToCompletedH1(at);
  const view = buildHistoryView({ h1raw, pair: 'EUR_USD', at });
  const co = runCoordinator({ h1raw, evalMs, pair: 'EUR_USD' });      // the exact path the backtest iterates
  assert.equal(view.d1.direction, co.d1.direction);
  assert.equal(view.h4.state, co.h4.state);
  assert.equal(view.h1.state, co.h1.state);
});
