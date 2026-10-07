'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  describeNetwork, estimateWindow, M15, PAIRS, CURRENCIES, STRENGTHNET_VERSION,
} = require('../../research/m15/strengthnet');

const T = Date.UTC(2026, 8, 9, 0, 0, 0);   // synchronized evaluation close
const split = (p) => p.split('_');

/** Build an ascending candle series for ONE pair-key so its log return over the
 *  last `hoursBack` is exactly rTarget (log-linear path; last close lands on t). */
function mkPair(t, hoursBack, rTarget) {
  const n = hoursBack * 4;
  const d = n > 1 ? rTarget / (n - 1) : 0;
  const startOpen = t - n * M15;
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = Math.exp(i * d);
    const open = Math.exp((i === 0 ? 0 : i - 1) * d);
    out.push({ openMs: startOpen + i * M15, open, high: Math.max(open, close) * 1.0002, low: Math.min(open, close) * 0.9998, close, volume: 100, complete: true, source: 'OANDA' });
  }
  return out;
}

/** Full 28-pair histories from a zero-sum truth xTrue, with optional perturbations. */
function genHistories(t, hoursBack, xTrue, opt = {}) {
  const { flip = [], drop = [], shock = null, invertKeys = [], onlyPairs = null } = opt;
  const H = {};
  const pairs = onlyPairs || PAIRS;
  for (const p of pairs) {
    if (drop.includes(p)) continue;
    const [b, q] = split(p);
    let r = (xTrue[b] || 0) - (xTrue[q] || 0);
    if (flip.includes(p)) r = -r;                    // contradictory observation
    if (shock && shock.pair === p) r = shock.r;      // pair-specific shock
    if (invertKeys.includes(p)) H[`${q}_${b}`] = mkPair(t, hoursBack, -r);  // inverse orientation key
    else H[p] = mkPair(t, hoursBack, r);
  }
  return H;
}

const zeroSum = (x) => { const m = CURRENCIES.reduce((s, c) => s + x[c], 0) / 8; const o = {}; for (const c of CURRENCIES) o[c] = x[c] - m; return o; };

// ── 1. Known effects are recovered ────────────────────────────────────────────
test('synthetic network with known zero-sum effects is recovered (residuals ~0)', () => {
  const xTrue = zeroSum({ USD: 0.004, EUR: 0.002, GBP: 0.006, JPY: -0.005, CHF: -0.001, CAD: -0.002, AUD: -0.003, NZD: -0.001 });
  const H = genHistories(T, 24, xTrue);
  const e = estimateWindow(H, { asOfCloseMs: T, windowHours: 24 });
  assert.equal(e.available, true);
  assert.equal(e.coverage.pairsUsed, 28);
  for (const c of CURRENCIES) assert.ok(Math.abs(e.effects.byCurrency[c] - xTrue[c]) < 1e-6, `${c} ${e.effects.byCurrency[c]} vs ${xTrue[c]}`);
  assert.ok(Math.abs(e.effects.sumZeroCheck) < 1e-9);
  assert.ok(e.diagnostics.rmse < 1e-7);
  assert.equal(e.diagnostics.fullRank, true);           // rank k-1 = 7
  assert.ok(e.diagnostics.conditionNumber < 1.0001);    // complete graph ⇒ ~1
});

// ── 2. Inverse orientation handled ────────────────────────────────────────────
test('inverse-orientation key (USD_EUR) yields identical canonical effects', () => {
  const xTrue = zeroSum({ USD: 0.003, EUR: -0.004, GBP: 0.002, JPY: 0.001, CHF: -0.001, CAD: 0.000, AUD: -0.0005, NZD: -0.0005 });
  const base = estimateWindow(genHistories(T, 24, xTrue), { asOfCloseMs: T, windowHours: 24 });
  const inv = estimateWindow(genHistories(T, 24, xTrue, { invertKeys: ['EUR_USD'] }), { asOfCloseMs: T, windowHours: 24 });
  assert.equal(inv.available, true);
  assert.equal(inv.coverage.pairsUsed, 28);              // EUR_USD still present via USD_EUR
  for (const c of CURRENCIES) assert.ok(Math.abs(inv.effects.byCurrency[c] - base.effects.byCurrency[c]) < 1e-9);
});

// ── 3. Mathematically equivalent pairs are not double-counted ────────────────
test('providing both EUR_USD and USD_EUR counts as ONE sample', () => {
  const xTrue = zeroSum({ USD: 0.002, EUR: 0.001, GBP: 0.0, JPY: 0.0, CHF: 0.0, CAD: 0.0, AUD: -0.001, NZD: -0.002 });
  const H = genHistories(T, 24, xTrue);
  H['USD_EUR'] = mkPair(T, 24, -((xTrue.EUR) - (xTrue.USD)));   // duplicate of EUR_USD, inverted
  const e = estimateWindow(H, { asOfCloseMs: T, windowHours: 24 });
  assert.equal(e.coverage.pairsUsed, 28);                      // not 29
  assert.ok(e.coverage.equivalentDropped.includes('USD_EUR'));
});

// ── 4. One contradictory pair ⇒ large residual there, effects follow majority ─
test('one contradictory pair shows the largest residual, network stays sane', () => {
  const xTrue = zeroSum({ USD: 0.004, EUR: 0.003, GBP: 0.002, JPY: -0.002, CHF: -0.002, CAD: -0.001, AUD: -0.002, NZD: -0.002 });
  const e = estimateWindow(genHistories(T, 24, xTrue, { flip: ['GBP_JPY'] }), { asOfCloseMs: T, windowHours: 24 });
  const resid = e.diagnostics.residualsByPair;
  const worst = Object.entries(resid).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0][0];
  assert.equal(worst, 'GBP_JPY');
  assert.ok(e.diagnostics.rmse > 0);
  // effects still broadly track the truth despite the one bad edge
  assert.ok(Math.abs(e.effects.byCurrency.USD - xTrue.USD) < 0.002);
});

// ── 5. Missing pair coverage ⇒ reported, still available if connected ────────
test('missing pairs are reported, estimate remains available while connected', () => {
  const xTrue = zeroSum({ USD: 0.003, EUR: 0.002, GBP: 0.001, JPY: -0.001, CHF: -0.001, CAD: -0.001, AUD: -0.001, NZD: -0.002 });
  const e = estimateWindow(genHistories(T, 24, xTrue, { drop: ['EUR_USD', 'GBP_USD', 'AUD_NZD'] }), { asOfCloseMs: T, windowHours: 24 });
  assert.equal(e.available, true);
  assert.equal(e.coverage.pairsUsed, 25);
  assert.deepEqual(e.coverage.missingPairs, ['AUD_NZD', 'EUR_USD', 'GBP_USD']);
  assert.equal(e.diagnostics.connected, true);
});

// ── 6. Disconnected network ⇒ unavailable ─────────────────────────────────────
test('a disconnected network returns unavailable (not a fabricated estimate)', () => {
  // two currency clusters with NO linking pair
  const clusterA = ['USD', 'EUR', 'GBP', 'JPY'], clusterB = ['CHF', 'CAD', 'AUD', 'NZD'];
  const within = PAIRS.filter((p) => { const [b, q] = split(p); return (clusterA.includes(b) && clusterA.includes(q)) || (clusterB.includes(b) && clusterB.includes(q)); });
  const xTrue = zeroSum({ USD: 0.002, EUR: 0.001, GBP: 0.0, JPY: -0.003, CHF: 0.002, CAD: 0.001, AUD: -0.001, NZD: -0.002 });
  const e = estimateWindow(genHistories(T, 24, xTrue, { onlyPairs: within }), { asOfCloseMs: T, windowHours: 24 });
  assert.equal(e.available, false);
  assert.equal(e.reason, 'DISCONNECTED_NETWORK');
  assert.equal(e.components, 2);
});

// ── 7. A pair-specific shock must NOT confirm itself (LOPO) ───────────────────
test('pair-specific shock: full gap reacts, but leave-one-out does NOT confirm it', () => {
  const flat = Object.fromEntries(CURRENCIES.map((c) => [c, 0]));
  const H = genHistories(T, 24, flat, { shock: { pair: 'GBP_AUD', r: 0.02 } });
  const net = describeNetwork(H, { asOfCloseMs: T });
  const conf = net.leaveOnePairOut.confirmations['GBP_AUD'];
  assert.ok(Math.abs(conf.full.baseMinusQuote) > 0, 'full network reflects the shock');
  assert.equal(conf.leaveOut.baseMinusQuote, 0, 'remaining network is flat');
  assert.equal(conf.independentlyConfirmed, false, 'shock did not become its own confirmation');
});

// ── 8. A genuine broad move IS independently confirmed by LOPO ────────────────
test('a genuine broad move is independently confirmed when the pair is excluded', () => {
  const xTrue = zeroSum({ GBP: 0.006, AUD: -0.006, USD: 0.001, EUR: 0.001, JPY: 0.0, CHF: 0.0, CAD: -0.001, NZD: -0.001 });
  const net = describeNetwork(genHistories(T, 24, xTrue), { asOfCloseMs: T });
  const conf = net.leaveOnePairOut.confirmations['GBP_AUD'];
  assert.equal(conf.available, true);
  assert.ok(conf.full.baseMinusQuote > 0);
  assert.ok(conf.leaveOut.baseMinusQuote > 0);          // reproduced WITHOUT the GBP_AUD edge
  assert.equal(conf.independentlyConfirmed, true);
});

// ── 9. Breadth + leadership paths + relative/absolute separation ──────────────
test('breadth, leadership paths, and relative-vs-absolute labelling', () => {
  const xTrue = zeroSum({ GBP: 0.006, AUD: -0.006, USD: 0.002, EUR: 0.001, JPY: 0.0, CHF: 0.0, CAD: -0.001, NZD: -0.002 });
  const net = describeNetwork(genHistories(T, 24, xTrue), { asOfCloseMs: T });
  const h24 = net.windows.h24;
  assert.equal(h24.breadth.GBP.degree, 7);
  assert.equal(h24.breadth.GBP.fraction, 1);            // every GBP pair agrees with GBP-up
  assert.ok(/RELATIVE/.test(h24.effects.note));
  assert.ok('meanPairReturn' in h24.diagnostics);        // absolute drift reported separately
  assert.ok(net.paths12h.latest && net.paths12h.leadershipChanges);
});

// ── 10. No forward-fill / unsynchronized closes; zero-return handling ─────────
test('a pair not present at the synchronized close t is excluded, not filled', () => {
  const xTrue = zeroSum({ USD: 0.002, EUR: 0.001, GBP: 0.0, JPY: 0.0, CHF: 0.0, CAD: 0.0, AUD: -0.001, NZD: -0.002 });
  const H = genHistories(T, 24, xTrue);
  // truncate EUR_USD so its last close is one frame early (t - M15) ⇒ not at t
  H['EUR_USD'] = H['EUR_USD'].slice(0, -1);
  const e = estimateWindow(H, { asOfCloseMs: T, windowHours: 24 });
  assert.ok(e.coverage.missingPairs.includes('EUR_USD'));
  assert.equal(e.coverage.pairsUsed, 27);
  // zero-return pair is fine (no NaN)
  const flat = estimateWindow(genHistories(T, 24, Object.fromEntries(CURRENCIES.map((c) => [c, 0]))), { asOfCloseMs: T, windowHours: 24 });
  for (const c of CURRENCIES) assert.ok(Math.abs(flat.effects.byCurrency[c]) < 1e-9);
});

// ── 11. Determinism + version ─────────────────────────────────────────────────
test('deterministic output and version surfaced', () => {
  const xTrue = zeroSum({ USD: 0.003, EUR: 0.002, GBP: 0.001, JPY: -0.001, CHF: -0.001, CAD: -0.001, AUD: -0.001, NZD: -0.002 });
  const H = genHistories(T, 24, xTrue);
  const a = estimateWindow(H, { asOfCloseMs: T, windowHours: 24 });
  const b = estimateWindow(H, { asOfCloseMs: T, windowHours: 24 });
  assert.deepEqual(a, b);
  assert.equal(a.version, STRENGTHNET_VERSION);
});

// ── 12. The research module is self-contained (the old api/_m15 engine is retired) ─
test('research strengthnet is self-contained and does not depend on the retired engine', () => {
  // The old api/_m15 engine was removed when the new system went live; the research
  // network estimator stands alone with its own version and a distinct contract
  // (it consumes pair log-returns, not movement signals).
  assert.notEqual(STRENGTHNET_VERSION, undefined);
  const mod = require('../../research/m15/strengthnet');
  assert.ok(typeof mod.estimateWindow === 'function' && typeof mod.describeNetwork === 'function');
  assert.ok(!('evaluateCurrencyStrength' in mod));
});
