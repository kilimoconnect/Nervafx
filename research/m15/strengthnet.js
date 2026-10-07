'use strict';

/**
 * M15 Research — currency-strength NETWORK estimator (Stage B, pure/deterministic).
 *
 * A NETWORK DESCRIPTION, not a trade indicator. Given synchronized, completed M15
 * closes across the 28 pairs, it estimates eight ZERO-SUM currency effects x that
 * best explain the observed pair log-returns, with full diagnostics and a
 * leave-one-pair-out independent confirmation. It produces NO signals and NO
 * profitability claims. Isolated from api/_m15 (imports only the research loader
 * constants) and never touches a database.
 *
 * ── Model / exact equations ────────────────────────────────────────────────
 * For a window ending at the synchronized close t, each canonical pair p=(b,q)
 * has a log return over the OBSERVED interval:
 *     r_p = ln( close_last / close_first )           (close_last is the candle at t)
 * We model it as a difference of per-currency effects plus noise:
 *     r_p ≈ x_b − x_q + ε_p ,   with the identifiability constraint  Σ_c x_c = 0.
 * Weighted least squares  min_x Σ_p w_p (r_p − (x_b − x_q))²  gives the normal
 * equations  L x = β , where L is the weighted graph Laplacian of the currency
 * network and β_c = Σ_{base=c} w_p r_p − Σ_{quote=c} w_p r_p  (note Σ_c β_c = 0).
 * L is singular (null space = 1), so we solve the regularized, sum-zero system
 *     (L + (1/k)·11ᵀ) x = β   ⇒   x = L⁺β , which satisfies 1ᵀx = 0.
 * For the FULL complete 28-pair network with equal weights this reduces to the
 * closed form x_c = β_c / 8 (L = 8I − J); the general solver is used for the
 * leave-one-pair-out subnetworks (which are no longer complete).
 *
 * x is RELATIVE (zero-sum): it describes currency effects against each other, NOT
 * absolute investment returns. The mean pair drift is reported separately and is,
 * by construction, orthogonal to x.
 */

const { M15, PAIRS } = require('./loader');
const HOUR = 60 * 60 * 1000;

const STRENGTHNET_VERSION = 'm15-strengthnet-1.0.0';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
const WINDOWS_H = [12, 24, 36, 48];

// ── small linear algebra (dense, deterministic) ───────────────────────────────
function zeros(n, m) { return Array.from({ length: n }, () => new Array(m).fill(0)); }

/** Solve Ax=b (A square) by Gaussian elimination with partial pivoting. */
function gaussSolve(Ain, bin) {
  const n = bin.length;
  const A = Ain.map((r) => r.slice());
  const b = bin.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-15) continue;             // singular column; leave as-is
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) x[i] = Math.abs(A[i][i]) < 1e-15 ? 0 : b[i] / A[i][i];
  return x;
}

/** Eigenvalues of a symmetric matrix via cyclic Jacobi (ascending). */
function eigSym(Ain) {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p][q];
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let i = 0; i < n; i++) {
        const aip = A[i][p], aiq = A[i][q];
        A[i][p] = c * aip - s * aiq; A[i][q] = s * aip + c * aiq;
      }
      for (let i = 0; i < n; i++) {
        const api = A[p][i], aqi = A[q][i];
        A[p][i] = c * api - s * aqi; A[q][i] = s * api + c * aqi;
      }
    }
  }
  return A.map((r, i) => r[i]).sort((a, b) => a - b);
}

// ── pair orientation / canonicalization ───────────────────────────────────────
/** Resolve a pair key to canonical orientation; null if not one of the 28. */
function orient(key) {
  const [a, b] = key.split('_');
  if (PAIRS.includes(`${a}_${b}`)) return { base: a, quote: b, inverted: false, canon: `${a}_${b}` };
  if (PAIRS.includes(`${b}_${a}`)) return { base: b, quote: a, inverted: true, canon: `${b}_${a}` };
  return null;
}

// ── window return per pair (no forward-fill; require the synced frame at t) ────
function pairWindowReturn(cands, t, H) {
  const from = t - H * HOUR;
  const seen = new Set();
  const w = (cands || [])
    .filter((c) => c && c.complete !== false && c.openMs + M15 > from && c.openMs + M15 <= t)
    .sort((a, b) => a.openMs - b.openMs)
    .filter((c) => (seen.has(c.openMs) ? false : (seen.add(c.openMs), true)));  // drop dup openMs
  const atT = w.length > 0 && (w[w.length - 1].openMs + M15 === t);             // last close == synced t
  const nominal = 4 * H;
  if (w.length < 2 || !atT) return { ok: false, n: w.length, atT, nominal };
  const first = w[0].close, last = w[w.length - 1].close;
  if (!(first > 0) || !(last > 0)) return { ok: false, n: w.length, atT, nominal, badPrice: true };
  return {
    ok: true, r: Math.log(last / first), n: w.length, nominal,
    firstCloseMs: w[0].openMs + M15, lastCloseMs: t,
    coveragePct: +(100 * w.length / nominal).toFixed(1),
  };
}

// ── build edges (canonical, deduped) from histories at (t, H) ──────────────────
function buildEdges(historiesByPair, t, H, opts = {}) {
  const weights = opts.weights || {};
  const expected = opts.pairs || PAIRS;
  const edgesByCanon = new Map();
  const usedKeys = [], missing = [], unknown = [], equivalentDropped = [];
  for (const key of Object.keys(historiesByPair)) {
    const o = orient(key);
    if (!o) { unknown.push(key); continue; }
    const pr = pairWindowReturn(historiesByPair[key], t, H);
    if (!pr.ok) { missing.push(o.canon); continue; }
    // canonical return (invert sign if the key was given inverted)
    const r = o.inverted ? -pr.r : pr.r;
    if (edgesByCanon.has(o.canon)) { equivalentDropped.push(key); continue; } // not an independent sample
    const w = weights[o.canon] != null ? weights[o.canon] : (weights[key] != null ? weights[key] : 1);
    edgesByCanon.set(o.canon, { canon: o.canon, base: o.base, quote: o.quote, r, w, coveragePct: pr.coveragePct, n: pr.n, nominal: pr.nominal });
    usedKeys.push(key);
  }
  const edges = [...edgesByCanon.values()];
  for (const p of expected) if (!edgesByCanon.has(p)) if (!missing.includes(p)) missing.push(p);
  return { edges, missing, unknown, equivalentDropped, usedKeys };
}

// ── connectivity (BFS over present currencies) ─────────────────────────────────
function components(currencies, edges) {
  const adj = new Map(currencies.map((c) => [c, []]));
  for (const e of edges) { adj.get(e.base).push(e.quote); adj.get(e.quote).push(e.base); }
  const seen = new Set(); let comps = 0;
  for (const c of currencies) {
    if (seen.has(c)) continue;
    comps++; const stack = [c]; seen.add(c);
    while (stack.length) { const u = stack.pop(); for (const v of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); stack.push(v); } }
  }
  return comps;
}

// ── core estimation on a set of edges ──────────────────────────────────────────
function estimateFromEdges(edges, opts = {}) {
  const minPairs = opts.minPairs != null ? opts.minPairs : 7;
  const minDegree = opts.minDegree != null ? opts.minDegree : 1;
  const currencies = [...new Set(edges.flatMap((e) => [e.base, e.quote]))].sort();
  const k = currencies.length;
  const idx = new Map(currencies.map((c, i) => [c, i]));
  const degree = Object.fromEntries(currencies.map((c) => [c, 0]));
  for (const e of edges) { degree[e.base]++; degree[e.quote]++; }

  const comps = k ? components(currencies, edges) : 0;
  const connected = comps === 1;
  const minDeg = k ? Math.min(...currencies.map((c) => degree[c])) : 0;
  const sufficient = edges.length >= minPairs && minDeg >= minDegree;
  if (!connected || !sufficient || k < 2) {
    return { available: false, reason: !connected ? 'DISCONNECTED_NETWORK' : (k < 2 ? 'TOO_FEW_CURRENCIES' : 'INSUFFICIENT_COVERAGE'),
      currencies, k, edges: edges.length, components: comps, connected, minDegree: minDeg };
  }

  // Weighted Laplacian L and rhs β.
  const L = zeros(k, k); const beta = new Array(k).fill(0);
  for (const e of edges) {
    const i = idx.get(e.base), j = idx.get(e.quote);
    L[i][i] += e.w; L[j][j] += e.w; L[i][j] -= e.w; L[j][i] -= e.w;
    beta[i] += e.w * e.r; beta[j] -= e.w * e.r;
  }
  // Solve (L + (1/k)·11ᵀ) x = β  ⇒  sum-zero least-squares solution.
  const M = L.map((row) => row.map((v) => v + 1 / k));
  const xArr = gaussSolve(M, beta);
  const byCurrency = {}; currencies.forEach((c, i) => { byCurrency[c] = +xArr[i].toFixed(8); });
  const sumZero = +currencies.reduce((s, c) => s + byCurrency[c], 0).toFixed(10);

  // Residuals + weighted RMSE.
  let ss = 0, wsum = 0;
  const residualsByPair = {};
  for (const e of edges) {
    const fitted = byCurrency[e.base] - byCurrency[e.quote];
    const res = e.r - fitted;
    residualsByPair[e.canon] = +res.toFixed(8);
    ss += e.w * res * res; wsum += e.w;
  }
  const rmse = +Math.sqrt(ss / (wsum || 1)).toFixed(8);

  // Conditioning / rank from the Laplacian spectrum (λ≈0 per component).
  const eig = eigSym(L);
  const tol = 1e-9 * (eig[eig.length - 1] || 1);
  const nonzero = eig.filter((v) => v > tol);
  const rank = nonzero.length;
  const lambdaMax = eig[eig.length - 1];
  const lambdaMin = nonzero.length ? nonzero[0] : 0;
  const conditionNumber = lambdaMin > 0 ? +(lambdaMax / lambdaMin).toFixed(4) : Infinity;

  // Breadth: how many of a currency's pair relationships agree with its net sign.
  const breadth = {};
  for (const c of currencies) {
    const s = Math.sign(byCurrency[c]);
    let agree = 0, deg = 0;
    for (const e of edges) {
      if (e.base !== c && e.quote !== c) continue;
      deg++;
      const contribSign = Math.sign((e.base === c ? 1 : -1) * e.r);
      if (s !== 0 && contribSign === s) agree++;
    }
    breadth[c] = { agree, degree: deg, fraction: +(deg ? agree / deg : 0).toFixed(3) };
  }

  // Absolute (market) drift — reported SEPARATELY from the relative effects.
  const meanPairReturn = +(edges.reduce((s, e) => s + e.r, 0) / edges.length).toFixed(8);

  const ranked = currencies.slice().sort((a, b) => byCurrency[b] - byCurrency[a]);
  return {
    available: true, currencies, k, edges: edges.length,
    effects: { byCurrency, sumZeroCheck: sumZero, ranked, note: 'RELATIVE zero-sum currency effects — NOT absolute investment returns' },
    gaps: Object.fromEntries(edges.map((e) => [e.canon, { baseMinusQuote: +(byCurrency[e.base] - byCurrency[e.quote]).toFixed(8), observedReturn: +e.r.toFixed(8), residual: residualsByPair[e.canon] }])),
    breadth,
    diagnostics: { connected, components: comps, minDegree: minDeg, rank, fullRank: rank === k - 1, conditionNumber, wellConditioned: conditionNumber < 1e6, rmse, residualsByPair, meanPairReturn, degree },
  };
}

// ── per-window public estimate ─────────────────────────────────────────────────
function estimateWindow(historiesByPair, opts = {}) {
  const t = opts.asOfCloseMs;
  if (t == null) throw new Error('estimateWindow: asOfCloseMs (t) required');
  const H = opts.windowHours || 24;
  const expected = opts.pairs || PAIRS;
  const { edges, missing, unknown, equivalentDropped } = buildEdges(historiesByPair, t, H, opts);
  const coverage = { pairsExpected: expected.length, pairsUsed: edges.length, missingPairs: missing.sort(), unknownKeys: unknown, equivalentDropped, currenciesPresent: [...new Set(edges.flatMap((e) => [e.base, e.quote]))].sort() };
  const est = estimateFromEdges(edges, opts);
  return {
    version: STRENGTHNET_VERSION, asOfCloseUtc: new Date(t).toISOString(), asOfCloseMs: t, windowHours: H,
    coverage, returnsByPair: Object.fromEntries(edges.map((e) => [e.canon, +e.r.toFixed(8)])),
    ...est,
  };
}

// ── leave-one-pair-out independent confirmation ────────────────────────────────
/**
 * Re-estimate the network with ONE pair's edge removed. The excluded pair's own
 * return never enters the LOPO estimate, so a shock confined to that pair cannot
 * confirm itself. Confirmation = the remaining (connected, covered) network
 * reproduces the SIGN of the full-network base−quote gap. Figures are kept
 * separately labelled (`full` vs `leaveOut`).
 */
function leaveOnePairOut(edges, canon, fullGap, opts = {}) {
  const base = canon.split('_')[0], quote = canon.split('_')[1];
  const remaining = edges.filter((e) => e.canon !== canon);
  const est = estimateFromEdges(remaining, opts);
  if (!est.available) return { pair: canon, available: false, reason: est.reason, independentlyConfirmed: false };
  const loGap = +(est.effects.byCurrency[base] - est.effects.byCurrency[quote]).toFixed(8);
  const sameSign = Math.sign(loGap) !== 0 && Math.sign(loGap) === Math.sign(fullGap);
  return {
    pair: canon, available: true,
    full: { baseMinusQuote: fullGap }, leaveOut: { baseMinusQuote: loGap, connected: est.diagnostics.connected, minDegree: est.diagnostics.minDegree, conditionNumber: est.diagnostics.conditionNumber },
    independentlyConfirmed: sameSign,
    note: 'leaveOut excludes this pair entirely; a pair-specific shock will NOT reproduce here',
  };
}

// ── top-level network description (all windows + paths + LOPO) ─────────────────
function describeNetwork(historiesByPair, opts = {}) {
  const t = opts.asOfCloseMs;
  if (t == null) throw new Error('describeNetwork: asOfCloseMs (t) required');

  const windows = {};
  for (const H of WINDOWS_H) windows[`h${H}`] = estimateWindow(historiesByPair, { ...opts, windowHours: H, asOfCloseMs: t });

  // Strength PATHS: latest 12h (t−12h→t) vs the immediately preceding 12h.
  const latest12 = estimateWindow(historiesByPair, { ...opts, windowHours: 12, asOfCloseMs: t });
  const prev12 = estimateWindow(historiesByPair, { ...opts, windowHours: 12, asOfCloseMs: t - 12 * HOUR });
  let leadershipChanges = null;
  if (latest12.available && prev12.available) {
    const rankMap = (e) => Object.fromEntries(e.effects.ranked.map((c, i) => [c, i + 1]));
    const rl = rankMap(latest12), rp = rankMap(prev12);
    const changes = CURRENCIES.filter((c) => rl[c] != null && rp[c] != null && rl[c] !== rp[c])
      .map((c) => ({ currency: c, previousRank: rp[c], latestRank: rl[c] }));
    leadershipChanges = { previousLeader: prev12.effects.ranked[0], latestLeader: latest12.effects.ranked[0], changed: prev12.effects.ranked[0] !== latest12.effects.ranked[0], rankChanges: changes };
  }

  // Leave-one-pair-out confirmation on the primary (24h) window.
  const primary = windows.h24;
  const lopo = {};
  if (primary.available) {
    const { edges } = buildEdges(historiesByPair, t, 24, opts);
    for (const e of edges) lopo[e.canon] = leaveOnePairOut(edges, e.canon, primary.gaps[e.canon].baseMinusQuote, opts);
  }

  return {
    version: STRENGTHNET_VERSION, asOfCloseUtc: new Date(t).toISOString(), asOfCloseMs: t,
    note: 'Network DESCRIPTION of RELATIVE, zero-sum currency effects — not a trade indicator and not absolute returns.',
    windows,
    paths12h: { latest: latest12.available ? latest12.effects.byCurrency : null, previous: prev12.available ? prev12.effects.byCurrency : null, leadershipChanges },
    leaveOnePairOut: { window: '24h', confirmations: lopo },
  };
}

module.exports = {
  STRENGTHNET_VERSION, CURRENCIES, WINDOWS_H, HOUR, M15, PAIRS,
  describeNetwork, estimateWindow, estimateFromEdges, leaveOnePairOut,
  buildEdges, pairWindowReturn, orient, components, gaussSolve, eigSym,
};
