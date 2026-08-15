'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { confirmM15 } = require('../../api/_lfe-mss');
const { MSS_STATUS, M15_MS, HOUR_MS } = require('../../api/_lfe-constants');

const T0 = Date.UTC(2026, 7, 3, 0, 0, 0);
const ATR = 0.0004; // M15 ATR (4 pips)
const L = 1.10000;
const closeMs = (idx) => T0 + (idx + 1) * M15_MS;

function mk(rows) {
  return rows.map((r, i) => ({ openMs: T0 + i * M15_MS, time: new Date(T0 + i * M15_MS).toISOString(), open: r[0], high: r[1], low: r[2], close: r[3] }));
}

// FAILED BUYERS → SELL. Pivot low at idx2 (1.09950); breach at idx5; break at idx6.
const sellRunup = [
  [1.09980, 1.09990, 1.09970, 1.09985],
  [1.09985, 1.09990, 1.09960, 1.09965],
  [1.09965, 1.09975, 1.09950, 1.09970], // pivot low 1.09950
  [1.09970, 1.09995, 1.09965, 1.09990],
  [1.09990, 1.09998, 1.09985, 1.09996], // higher high, still below L
  [1.09996, 1.10030, 1.09994, 1.10020], // breach: high > L
];
const sellEvent = {
  pair: 'EUR_USD', direction: 'SELL', levelCentre: L, sweepExtreme: 1.10030,
  h1Atr: 0.0010, breachAtMs: closeMs(5), failureAtMs: closeMs(5),
};

test('SELL confirms when M15 breaks the prior swing low after the breach', () => {
  const cs = mk(sellRunup.concat([[1.10020, 1.10025, 1.09930, 1.09940]])); // idx6 break
  const r = confirmM15(sellEvent, cs, null, { evalMs: closeMs(6), m15AtrNow: ATR });
  assert.equal(r.status, MSS_STATUS.CONFIRMED);
  assert.equal(r.breakLevel, 1.09950);
  assert.equal(r.confirmAtMs, closeMs(6));
  assert.ok(r.confirmAtMs > r.breachTime, 'break occurs after the breach (no retroactive break)');
});

test('a confirmation is never released before the H1 failure candle has closed', () => {
  const cs = mk(sellRunup.concat([[1.10020, 1.10025, 1.09930, 1.09940]]));
  // evalMs sits before the H1 failure close → PENDING, not CONFIRMED.
  const r = confirmM15(sellEvent, cs, null, { evalMs: closeMs(6), m15AtrNow: ATR, cfg: undefined,
    // force "H1 not closed yet" by pushing failureAtMs into the future
  });
  assert.equal(r.status, MSS_STATUS.CONFIRMED); // baseline: released

  const notClosed = Object.assign({}, sellEvent, { failureAtMs: closeMs(9) });
  const r2 = confirmM15(notClosed, cs, null, { evalMs: closeMs(6), m15AtrNow: ATR });
  assert.equal(r2.status, MSS_STATUS.PENDING);
});

test('SELL invalidates when the sweep high is taken out again before confirmation', () => {
  const cs = mk(sellRunup.concat([[1.10020, 1.10055, 1.10015, 1.10050]])); // new high > sweep 1.10030
  const r = confirmM15(sellEvent, cs, null, { evalMs: closeMs(6), m15AtrNow: ATR });
  assert.equal(r.status, MSS_STATUS.INVALIDATED);
});

test('SELL expires when no break occurs within eight M15 candles of the failure', () => {
  const hold = [];
  for (let i = 0; i < 9; i++) hold.push([1.10010, 1.10018, 1.10004, 1.10012]); // stay above, never break/sweep
  const cs = mk(sellRunup.concat(hold));
  const windowEnd = sellEvent.failureAtMs + 8 * M15_MS;
  const r = confirmM15(sellEvent, cs, null, { evalMs: windowEnd + M15_MS, m15AtrNow: ATR });
  assert.equal(r.status, MSS_STATUS.EXPIRED);
});

test('when no valid M15 pivot exists the event stays UNCONFIRMED', () => {
  // Monotone rise into the breach: no confirmed swing low to break.
  const cs = mk([
    [1.09960, 1.09975, 1.09955, 1.09972],
    [1.09972, 1.09988, 1.09970, 1.09985],
    [1.09985, 1.09998, 1.09983, 1.09996],
    [1.09996, 1.10030, 1.09994, 1.10020], // breach
    [1.10020, 1.10025, 1.09930, 1.09940], // would-be break, but no prior pivot low
  ]);
  const ev = Object.assign({}, sellEvent, { breachAtMs: closeMs(3), failureAtMs: closeMs(3) });
  const r = confirmM15(ev, cs, null, { evalMs: closeMs(4), m15AtrNow: ATR });
  assert.equal(r.status, MSS_STATUS.UNCONFIRMED);
});

test('FAILED SELLERS → BUY confirms when M15 breaks the prior swing high', () => {
  const cs = mk([
    [1.10020, 1.10030, 1.10010, 1.10015],
    [1.10015, 1.10040, 1.10008, 1.10035],
    [1.10035, 1.10050, 1.10030, 1.10045], // pivot high 1.10050
    [1.10045, 1.10046, 1.10020, 1.10030],
    [1.10030, 1.10036, 1.10015, 1.10020], // low stays above L
    [1.10020, 1.10025, 1.09970, 1.09980], // breakdown: low < L
    [1.09980, 1.10075, 1.09975, 1.10070], // break up through pivot high
  ]);
  const buyEvent = {
    pair: 'EUR_USD', direction: 'BUY', levelCentre: L, sweepExtreme: 1.09970,
    h1Atr: 0.0010, breachAtMs: closeMs(5), failureAtMs: closeMs(5),
  };
  const r = confirmM15(buyEvent, cs, null, { evalMs: closeMs(6), m15AtrNow: ATR });
  assert.equal(r.status, MSS_STATUS.CONFIRMED);
  assert.equal(r.breakLevel, 1.10050);
  assert.equal(r.confirmAtMs, closeMs(6));
});
