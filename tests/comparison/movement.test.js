'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildIndices } = require('../../research/comparison/index-build');
const { movementMetrics, paceChange } = require('../../research/comparison/movement');
const { movementTable, spreadAnalysis } = require('../../research/comparison/evolution');
const { dayStart } = require('../../research/comparison/periods');
const { PAIRS, M15_MS, CONFIG } = require('../../research/comparison/config');

const HOUR = 3600000;
const times = (n, step = M15_MS) => Array.from({ length: n }, (_, i) => i * step);

// ── Pure movementMetrics ────────────────────────────────────────────────────────────────────────
test('monotonic rise: full efficiency, +100 balance, all up intervals, no give-back', () => {
  const xs = [0, 0.1, 0.2, 0.3], m = movementMetrics(xs, times(4));
  assert.equal(m.direction, 'strengthening');
  assert.equal(m.M, 0.3);
  assert.equal(m.efficiency, 100);
  assert.equal(m.balance, 100);
  assert.equal(m.upIntervals, 3); assert.equal(m.downIntervals, 0);
  assert.equal(m.maxDrawdown, 0); assert.equal(m.currentFromHigh, 0);
});

test('monotonic fall: full efficiency, −100 balance, weakening', () => {
  const m = movementMetrics([0, -0.1, -0.2, -0.3], times(4));
  assert.equal(m.direction, 'weakening');
  assert.equal(m.efficiency, 100); assert.equal(m.balance, -100);
  assert.equal(m.downIntervals, 3);
});

test('alternating back to start: zero net, zero efficiency, balance 0', () => {
  const m = movementMetrics([0, 0.2, 0, 0.2, 0], times(5));
  assert.equal(m.M, 0); assert.equal(m.direction, 'unchanged');
  assert.equal(m.efficiency, 0); assert.equal(m.balance, 0);
  assert.equal(m.upIntervals, 2); assert.equal(m.downIntervals, 2);
  assert.ok(m.T > 0);
});

test('single jump then flat: high efficiency from one move (the documented caveat)', () => {
  const m = movementMetrics([0, 0.3, 0.3, 0.3, 0.3], times(5));
  assert.equal(m.efficiency, 100);            // close-to-close looks perfect…
  assert.equal(m.upIntervals, 1);             // …but only one interval actually moved
  assert.equal(m.flatIntervals, 3);
});

test('equal net, different churn: efficiency separates them', () => {
  const clean = movementMetrics([0, 0.1, 0.2, 0.3], times(4));
  const choppy = movementMetrics([0, 0.3, 0.1, 0.3], times(4));
  assert.equal(clean.M, choppy.M);            // same net +0.3
  assert.ok(clean.efficiency > choppy.efficiency, 'cleaner path is more efficient');
  assert.ok(choppy.efficiency < 100 && choppy.efficiency > 0);
});

test('fully flat: zero denominators return null, not NaN', () => {
  const m = movementMetrics([0, 0, 0, 0], times(4));
  assert.equal(m.direction, 'unchanged');
  assert.equal(m.T, 0);
  assert.equal(m.efficiency, null); assert.equal(m.balance, null);
  assert.equal(m.upwardShare, null); assert.equal(m.downwardShare, null);
  assert.equal(m.R, 0); assert.equal(m.normDrawdown, null);
  assert.equal(m.flatIntervals, 3);
});

test('tolerance separates magnitude (U/D) from frequency (persistence)', () => {
  // a sub-tolerance wiggle still adds to U but is NOT counted as an up interval
  const m = movementMetrics([0, 0.001, 0.101], times(3), 0.005);
  assert.ok(m.U > 0.1);                        // magnitude includes the tiny move
  assert.equal(m.upIntervals, 1);             // only the 0.1 step clears tolerance
  assert.equal(m.flatIntervals, 1);
});

test('opposing movement: drawdown off a high, current give-back, range-normalised', () => {
  const m = movementMetrics([0, 0.4, 0.1, 0.3], times(4));   // up to 0.4, back to 0.1, end 0.3
  assert.equal(m.high, 0.4); assert.equal(m.low, 0);
  assert.equal(m.maxDrawdown, 0.3);           // 0.4 → 0.1
  assert.equal(m.currentFromHigh, 0.1);       // 0.4 → 0.3
  assert.equal(m.R, 0.4);
  assert.equal(m.normFromHigh, 25);           // 0.1 / 0.4 = 25% of the window range
});

test('pace is pp per hour over the real elapsed time', () => {
  const m = movementMetrics([0, 0.3], [0, 2 * HOUR]);
  assert.equal(m.pace, 0.15);
  assert.equal(m.elapsedHours, 2);
});

test('insufficient observations → ok:false', () => {
  assert.equal(movementMetrics([0], [0]).ok, false);
  assert.equal(movementMetrics([], []).ok, false);
});

// ── paceChange ──────────────────────────────────────────────────────────────────────────────────
test('paceChange: up-increasing vs up-slowing (a slowdown is NOT a reversal)', () => {
  assert.equal(paceChange(0.2, 0.1).label, 'up-pace-increasing');
  assert.equal(paceChange(0.1, 0.2).label, 'up-pace-slowing');
  assert.equal(paceChange(0.05, 0.3).label, 'up-pace-slowing');   // big slowdown, still same direction
});
test('paceChange: down regime and sign change', () => {
  assert.equal(paceChange(-0.2, -0.1).label, 'down-pace-increasing');
  assert.equal(paceChange(-0.1, -0.2).label, 'down-pace-slowing');
  assert.equal(paceChange(0.1, -0.1).label, 'direction-changed');
  assert.equal(paceChange(-0.1, 0.1).label, 'direction-changed');
});
test('paceChange: null when a pace is missing', () => {
  assert.equal(paceChange(null, 0.1), null);
  assert.equal(paceChange(0.1, null), null);
});

// ── Integration: movementTable over the real index build ─────────────────────────────────────────
// EAT midnight = 21:00 UTC prior day. Only EUR moves (per-step log growth g); the zero-sum build
// gives EUR +7g/8 and every other currency −g/8 per step.
const START = Date.UTC(2025, 4, 1, 21, 0, 0);
const DAY = 24 * HOUR, STEPS_DAY = DAY / M15_MS, PRE = 4;   // small pre-midnight roll so an early-day 4h window can be genuinely short of history
const DATA_START = START - PRE * M15_MS;

function network(nSteps, gForTime) {
  const by = {}; for (const p of PAIRS) by[p] = [];
  let G = 0;
  for (let i = 0; i < nSteps; i++) {
    const t = DATA_START + i * M15_MS;
    if (i > 0) G += gForTime(t);
    const V = { EUR: Math.exp(G) }, val = (c) => (V[c] != null ? V[c] : 1);
    for (const p of PAIRS) { const [b, q] = p.split('_'); const px = val(b) / val(q); by[p].push({ openMs: t, open: px, high: px, low: px, close: px }); }
  }
  return by;
}

test('rising day but falling last hour: dailyPerf positive while the 1h window is weakening', () => {
  const cutoff = START + 40 * M15_MS;                         // 10h into the EAT day
  const g = (t) => (t > cutoff - 4 * M15_MS && t <= cutoff) ? -0.0006 : 0.0003;
  const built = buildIndices(network(PRE + 41, g));
  const mt = movementTable(built, null, cutoff, { tol: 0.005, cfg: CONFIG });
  const eur = mt.perCurrency.find((r) => r.currency === 'EUR');
  assert.ok(eur.dailyPerf > 0, 'EUR up on the day');
  assert.equal(eur.today.direction, 'strengthening');
  assert.ok(eur.h1.M < 0, 'EUR fell over the last hour');
  assert.equal(eur.h1.direction, 'weakening');
});

test('weakening 4h window with an upward rebound off the low', () => {
  const cutoff = START + 40 * M15_MS;
  const g = (t) => {
    const k = Math.round((t - (cutoff - 16 * M15_MS)) / M15_MS);   // 1..16 inside the 4h window
    if (k >= 1 && k <= 8) return -0.0004;      // fall
    if (k >= 9 && k <= 12) return 0.0003;      // rebound
    if (k >= 13 && k <= 16) return -0.0002;    // soft fade (does not undercut the low)
    return 0.0001;                             // mild drift before the window
  };
  const built = buildIndices(network(PRE + 41, g));
  const mt = movementTable(built, null, cutoff, { tol: 0.005, cfg: CONFIG });
  const eur = mt.perCurrency.find((r) => r.currency === 'EUR').h4;
  assert.equal(eur.direction, 'weakening');
  assert.ok(eur.maxRebound > 0, 'a rebound off the low exists');
  assert.ok(eur.currentFromLow > 0, 'ended above the window low');
});

test('midnight crossing: a 4h window spanning midnight is continuous (no reset discontinuity)', () => {
  const cutoff = START + DAY + 2 * M15_MS;                    // just after day-2 midnight
  const built = buildIndices(network(PRE + Number(STEPS_DAY) + 4, () => 0.0003));   // steady rise throughout
  const mt = movementTable(built, null, cutoff, { tol: 0.005, cfg: CONFIG });
  const h4 = mt.perCurrency.find((r) => r.currency === 'EUR').h4;
  assert.equal(h4.ok, true);
  assert.equal(h4.n, 16);
  assert.equal(h4.efficiency, 100, 'monotonic across midnight — no reset jump');
  assert.equal(h4.direction, 'strengthening');
});

test('insufficient history: 4h window unavailable, today/1h still computed', () => {
  const cutoff = START + 3 * M15_MS;                          // only ~19 steps of data exist
  const built = buildIndices(network(PRE + 4, () => 0.0003));
  const mt = movementTable(built, null, cutoff, { tol: 0.005, cfg: CONFIG });
  assert.equal(mt.windows.h4.available, false);
  const eur = mt.perCurrency.find((r) => r.currency === 'EUR');
  assert.equal(eur.h4.ok, false);
  assert.ok(/insufficient|coverage/.test(eur.h4.reason));
  assert.equal(eur.today.ok, true);
});

test('market gap in the window is not bridged: window withheld', () => {
  const cutoff = START + 40 * M15_MS;
  const by = network(PRE + 41, () => 0.0003);
  // drop 3 consecutive candles ~6 steps before the cutoff from EVERY pair → a gap in the timeline
  const dropFrom = cutoff - 6 * M15_MS, dropTo = cutoff - 4 * M15_MS;
  for (const p of PAIRS) by[p] = by[p].filter((c) => !(c.openMs >= dropFrom && c.openMs < dropTo));
  const built = buildIndices(by);
  const mt = movementTable(built, null, cutoff, { tol: 0.005, cfg: CONFIG });
  assert.equal(mt.windows.h4.available, false, '4h window spans the gap → unavailable');
  assert.ok(mt.windows.h4.incomplete || /coverage/.test(mt.windows.h4.reason || ''));
});

test('breadth orientation: EUR strengthens vs all 7; USD (quote of EUR) weakens vs exactly 1', () => {
  const cutoff = START + 20 * M15_MS;
  const built = buildIndices(network(PRE + 21, () => 0.0003));
  const mt = movementTable(built, network(PRE + 21, () => 0.0003), cutoff, { tol: 0.005, cfg: CONFIG });
  const eur = mt.perCurrency.find((r) => r.currency === 'EUR').today.breadth;
  const usd = mt.perCurrency.find((r) => r.currency === 'USD').today.breadth;
  assert.equal(eur.appreciated, 7, 'EUR up against all counterparts');
  assert.equal(usd.depreciated, 1, 'USD down only against EUR (sign flipped as quote)');
  assert.equal(usd.unchanged, 6);
});

test('no future-data leakage: appending later candles does not change metrics at the cutoff', () => {
  const cutoff = START + 40 * M15_MS;
  const g = () => 0.0003;
  const a = movementTable(buildIndices(network(PRE + 41, g)), null, cutoff, { tol: 0.005, cfg: CONFIG });
  const b = movementTable(buildIndices(network(PRE + 41 + 12, g)), null, cutoff, { tol: 0.005, cfg: CONFIG });   // +12 future steps
  const ea = a.perCurrency.find((r) => r.currency === 'EUR'), eb = b.perCurrency.find((r) => r.currency === 'EUR');
  for (const w of ['today', 'h4', 'h1']) {
    assert.equal(ea[w].M, eb[w].M, w + ' net movement unchanged');
    assert.equal(ea[w].efficiency, eb[w].efficiency, w + ' efficiency unchanged');
  }
});

test('two-currency index spread: EUR − USD strengthens while EUR rises and USD falls', () => {
  const cutoff = START + 20 * M15_MS;
  const built = buildIndices(network(PRE + 21, () => 0.0003));
  const sp = spreadAnalysis(built, 'EUR', 'USD', cutoff, { tol: 0.005 });
  assert.equal(sp.ok, true);
  assert.equal(sp.windows.today.direction, 'strengthening');
  assert.ok(sp.windows.today.M > 0);
  assert.equal(spreadAnalysis(built, 'EUR', 'EUR', cutoff).ok, false);   // same currency rejected
});
