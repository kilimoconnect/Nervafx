'use strict';

/**
 * NervaFX Currency Movement Engine — pure math core.
 *
 * Pair log returns + the eight-currency network decomposition via constrained
 * least squares (sum of currency movements = 0), solved with a 9×9 Gaussian
 * elimination with partial pivoting. Reuses no external linear-algebra library.
 */

const { CURRENCIES } = require('./_cme-constants');

const CIDX = {};
CURRENCIES.forEach((c, i) => { CIDX[c] = i; });

/** Log return of a pair over a window: ln(endClose / startOpen). */
function pairLogReturn(startOpen, endClose) {
  if (!(startOpen > 0) || !(endClose > 0)) return null;
  return Math.log(endClose / startOpen);
}

/** ATR-normalised (diagnostic) movement of a pair. */
function pairMoveATR(startOpen, endClose, atrValue) {
  if (!atrValue || atrValue <= 0) return 0;
  return (endClose - startOpen) / atrValue;
}

/** Solve a square linear system M x = y (Gaussian elimination, partial pivoting). */
function solveLinear(M, y) {
  const n = y.length;
  const A = M.map((row, i) => row.slice().concat([y[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-15) throw new Error('singular matrix');
    const t = A[col]; A[col] = A[piv]; A[piv] = t;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) A[r][k] -= f * A[col][k];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = A[i][n] / A[i][i];
  return x;
}

/**
 * Constrained least-squares decomposition of pair log returns into eight
 * currency movements with Σ movement = 0.
 *
 * @param {Object} pairReturns  { 'EUR_USD': logReturn, ... } (missing pairs skipped)
 * @param {Object} [weights]    { pair: w } (defaults to equal weights)
 * @returns {{movement:Object, residuals:Object, ssr:number, pairsUsed:number}}
 */
function solveCurrencySystem(pairReturns, weights) {
  const nc = CURRENCIES.length; // 8
  const L = Array.from({ length: nc }, () => new Array(nc).fill(0));
  const b = new Array(nc).fill(0);
  const rows = [];

  for (const pair of Object.keys(pairReturns)) {
    const r = pairReturns[pair];
    if (!Number.isFinite(r)) continue;
    const parts = pair.split('_');
    const bi = CIDX[parts[0]];
    const qi = CIDX[parts[1]];
    if (bi == null || qi == null) continue;
    const w = weights && weights[pair] != null ? weights[pair] : 1;
    // L += w·aaᵀ, b += w·a·r for the incidence row a (+1 base, −1 quote).
    L[bi][bi] += w; L[qi][qi] += w; L[bi][qi] -= w; L[qi][bi] -= w;
    b[bi] += w * r; b[qi] -= w * r;
    rows.push({ bi, qi, r, w, pair });
  }
  if (!rows.length) return { movement: zeroMovement(), residuals: {}, ssr: 0, pairsUsed: 0 };

  // Augmented KKT system: [ L 1 ; 1ᵀ 0 ] [m ; λ] = [b ; 0].
  const N = nc + 1;
  const M = Array.from({ length: N }, () => new Array(N).fill(0));
  const y = new Array(N).fill(0);
  for (let i = 0; i < nc; i++) { for (let j = 0; j < nc; j++) M[i][j] = L[i][j]; M[i][nc] = 1; y[i] = b[i]; }
  for (let j = 0; j < nc; j++) M[nc][j] = 1;
  M[nc][nc] = 0; y[nc] = 0;

  const sol = solveLinear(M, y);
  const movement = {};
  for (let i = 0; i < nc; i++) movement[CURRENCIES[i]] = sol[i];

  let ssr = 0;
  const residuals = {};
  for (const row of rows) {
    const pred = movement[CURRENCIES[row.bi]] - movement[CURRENCIES[row.qi]];
    const res = row.r - pred;
    residuals[row.pair] = res;
    ssr += row.w * res * res;
  }
  return { movement, residuals, ssr, pairsUsed: rows.length, lambda: sol[nc] };
}

function zeroMovement() {
  const m = {};
  for (const c of CURRENCIES) m[c] = 0;
  return m;
}

/** Signed per-currency contribution of a pair (base = +return, quote = −return). */
function signedContribution(pair, logReturn, currency) {
  const parts = pair.split('_');
  if (parts[0] === currency) return logReturn;
  if (parts[1] === currency) return -logReturn;
  return 0;
}

module.exports = {
  CIDX, pairLogReturn, pairMoveATR, solveLinear, solveCurrencySystem, signedContribution, zeroMovement,
};
