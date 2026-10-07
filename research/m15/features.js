'use strict';

/**
 * M15 Strategy Research — feature library (Stage 2). Pure, deterministic,
 * as-of-close. Isolated from the production engine (api/_m15/): it imports nothing
 * that changes production outputs; optional descriptors are READ-ONLY.
 *
 * INDEPENDENT vs DERIVED (labelled in every result's `meta`):
 *   Independent : r_t, R_N, U_N, D_N, path_N, block returns, z_N (lagged-scale
 *                 normalization), wick/body descriptor, currency x_{c,N}, breadth.
 *   Derived     : P_N = 100·R_N/path_N ; efficiency = |P_N|/100 = |R_N|/path_N
 *                 (SAME information as |P_N| — never independent confirmation);
 *                 pair gap = x_base − x_quote (related network evidence, not an
 *                 independent forecast of the pair).
 *
 * The four windows N∈{4,6,8,10} are MEASUREMENT HORIZONS shown together; they are
 * nested and overlapping, so they are NOT four independent confirmations. To see
 * progression without recounting, use the non-overlapping blocks (B1..B4).
 *
 * OHLC cannot reveal true buyer/seller order flow; the wick/body measure is a
 * shape descriptor only. OANDA volume is tick count, not trading volume.
 */

const crypto = require('crypto');
const { PAIRS } = require('./loader');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const NS = [4, 6, 8, 10];
const EPS = 1e-12;

const FEATURE_VERSION = 'm15-feat-1.0.0';
const FEATURE_CONFIG = Object.freeze({
  version: FEATURE_VERSION,
  horizons: NS,
  epsilon: EPS,
  scaleMethod: 'sample-std of earlier overlapping N-bar log returns (as-of, excludes current)',
  scaleMinObs: 30,                    // need this many earlier R_N before z is trusted
  breadthDeadband: 0.0004,            // prespecified noise deadband (log units) for breadth
  networkFactor: 8,                   // x_{c,N} = (1/8)·Σ sign(c,p)·R_{p,N}
});

function split(pair) { const [base, quote] = pair.split('_'); return { base, quote }; }
function ln(a, b) { return Math.log(a / b); }
function stdev(a) { if (a.length < 2) return 0; const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)); }

/** log returns r_t = ln(C_t/C_{t-1}) for a closes array. */
function logReturns(closes) { const r = []; for (let i = 1; i < closes.length; i++) r.push(ln(closes[i], closes[i - 1])); return r; }

/**
 * Horizon metrics at the LAST close for window N over a closes array.
 * U−D == R (algebraic identity) and U+D == path; both are surfaced so the identity
 * is explicit rather than hidden.
 */
function horizon(closes, N) {
  const n = closes.length;
  if (n <= N) return null;
  const R = ln(closes[n - 1], closes[n - 1 - N]);
  let U = 0, D = 0;
  for (let i = n - N; i < n; i++) { const r = ln(closes[i], closes[i - 1]); if (r > 0) U += r; else D += -r; }
  const path = U + D;
  const zero = path < EPS;
  const P = zero ? 0 : 100 * (U - D) / (path + EPS);
  return {
    R: +R, U: +U, D: +D, path: +path,
    P,                                  // derived: 100·R/path
    efficiency: Math.abs(P) / 100,      // derived: |P|/100 == |R|/path (same info as |P|)
    zeroMovement: zero,
    direction: R > 0 ? 'UP' : R < 0 ? 'DOWN' : 'NEUTRAL',
    identityHolds: Math.abs((U - D) - R) < 1e-9,   // U−D === R
  };
}

/** As-of lagged scale for R_N: sample std of EARLIER overlapping N-bar returns. */
function laggedScale(closes, N, cfg = FEATURE_CONFIG) {
  const earlier = [];
  for (let i = N; i < closes.length - 1; i++) earlier.push(ln(closes[i], closes[i - N])); // excludes the current (last) R_N
  if (earlier.length < cfg.scaleMinObs) return { scale: null, obs: earlier.length };
  return { scale: stdev(earlier), obs: earlier.length };
}

/** Wick/body shape descriptor (separate; NOT order flow). */
function wickBody(c) {
  const range = c.high - c.low; if (!(range > 0)) return { bodyFrac: 0, upperWickFrac: 0, lowerWickFrac: 0 };
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return { bodyFrac: body / range, upperWickFrac: upper / range, lowerWickFrac: lower / range };
}

/**
 * Full pair feature set at the as-of close. `candles` are the as-of history
 * (ascending, last = the frame). Returns horizons, non-overlapping blocks and
 * normalization, all labelled independent/derived.
 */
function pairFeatures(candles, opts = {}) {
  const cfg = opts.cfg || FEATURE_CONFIG;
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const H = {};
  for (const N of cfg.horizons) {
    const h = horizon(closes, N);
    if (h) { const s = laggedScale(closes, N, cfg); h.scale = s.scale; h.scaleObs = s.obs; h.z = s.scale ? +(h.R / s.scale) : null; }
    H[N] = h;
  }
  // Non-overlapping blocks: B1=R4 (4 bars), B2=R6−R4, B3=R8−R6, B4=R10−R8 (2 bars each).
  const R = (N) => (H[N] ? H[N].R : null);
  let blocks = null;
  if (R(4) != null && R(6) != null && R(8) != null && R(10) != null) {
    const B1 = R(4), B2 = R(6) - R(4), B3 = R(8) - R(6), B4 = R(10) - R(8);
    blocks = {
      B1: { ret: B1, bars: 4, perCandle: B1 / 4 },
      B2: { ret: B2, bars: 2, perCandle: B2 / 2 },
      B3: { ret: B3, bars: 2, perCandle: B3 / 2 },
      B4: { ret: B4, bars: 2, perCandle: B4 / 2 },
      reconstructsR10: Math.abs((B1 + B2 + B3 + B4) - R(10)) < 1e-9,   // blocks re-sum to R10
    };
  }
  return {
    pair: opts.pair || null,
    close: n ? closes[n - 1] : null,
    rLast: n >= 2 ? ln(closes[n - 1], closes[n - 2]) : null,
    horizons: H,
    blocks,
    wickBody: n ? wickBody(candles[n - 1]) : null,
    meta: {
      independent: ['R', 'U', 'D', 'path', 'z', 'blocks.*.ret', 'wickBody'],
      derived: ['P (=100·R/path)', 'efficiency (=|P|/100)'],
      note: 'The 4 horizons are nested/overlapping measurement windows, not independent confirmations.',
    },
  };
}

/**
 * Basket-relative currency movement over the 28-pair equal-weight network for one
 * horizon N. RByPair maps pair → R_{p,N} (raw log return). Missing pairs are
 * skipped (recorded in breadth participation). Everything is in COMPARABLE log
 * units. The pair `gap` is the RAW x_base − x_quote (never a difference of
 * separately standardized/tanh'd scores).
 */
function currencyMovement(RByPair, opts = {}) {
  const cfg = opts.cfg || FEATURE_CONFIG;
  const deadband = opts.deadband != null ? opts.deadband : cfg.breadthDeadband;
  const x = {}; for (const c of CURRENCIES) x[c] = 0;
  const contributors = {}; for (const c of CURRENCIES) contributors[c] = 0;
  for (const p of PAIRS) {
    const R = RByPair[p]; if (R == null) continue;
    const { base, quote } = split(p);
    x[base] += R; x[quote] -= R; contributors[base]++; contributors[quote]++;
  }
  for (const c of CURRENCIES) x[c] /= cfg.networkFactor;   // (1/8)·Σ sign·R
  const zeroSum = Math.abs(CURRENCIES.reduce((s, c) => s + x[c], 0)) < 1e-9;
  // breadth over each currency's 7 relationships, with the prespecified deadband
  const breadth = {};
  for (const c of CURRENCIES) {
    let pos = 0, neg = 0, part = 0;
    for (const p of PAIRS) {
      const { base, quote } = split(p); if (base !== c && quote !== c) continue;
      const R = RByPair[p]; if (R == null) continue;
      const s = base === c ? R : -R; part++;
      if (s > deadband) pos++; else if (s < -deadband) neg++;
    }
    breadth[c] = { pos, neg, net: pos - neg, participating: part };
  }
  const gap = {};
  for (const p of PAIRS) { const { base, quote } = split(p); gap[p] = x[base] - x[quote]; }
  return { N: opts.N ?? null, x, contributors, zeroSum, breadth, gap, deadband,
    meta: { note: 'x is comparable log units; gap = raw x_base − x_quote (related evidence, NOT an independent pair forecast). Never subtract individually normalized/tanh scores.' } };
}

/** Deterministic hash of the feature formulas/config (source fingerprint). */
function featureHash(cfg = FEATURE_CONFIG) {
  return crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);
}

module.exports = {
  CURRENCIES, NS, FEATURE_VERSION, FEATURE_CONFIG, EPS, split,
  logReturns, horizon, laggedScale, wickBody, pairFeatures, currencyMovement, featureHash,
};
