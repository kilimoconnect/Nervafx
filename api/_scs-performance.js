'use strict';

/**
 * SCS — performance reporting (pure). Computes stats ONLY from definite stored
 * outcomes (TARGET_HIT / STOP_HIT). Never infers missing outcomes or fabricates
 * data; pending/active/expired/rejected records are counted as signals but not
 * as realized trades. All results are in R.
 */

const { CONFIG } = require('./_scs-config');

const R_WIN = CONFIG.targetR;   // +2R at target
const R_LOSS = -1;              // −1R at stop

function outcomeR(status) {
  if (status === 'TARGET_HIT') return R_WIN;
  if (status === 'STOP_HIT') return R_LOSS;
  return null;                  // not a realized trade
}

/** UTC-hour session bucket for a trade time. */
function sessionOf(ms) {
  const h = new Date(ms).getUTCHours();
  if (h >= 0 && h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  if (h >= 13 && h < 21) return 'NEWYORK';
  return 'OFF';
}

function reduceStats(rs) {
  const trades = rs.length;
  const wins = rs.filter((r) => r > 0).length;
  const losses = rs.filter((r) => r < 0);
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sum = rs.reduce((a, b) => a + b, 0);
  // equity curve → max drawdown (in R)
  let peak = 0, eq = 0, maxDD = 0;
  for (const r of rs) { eq += r; if (eq > peak) peak = eq; if (peak - eq > maxDD) maxDD = peak - eq; }
  // longest losing streak
  let streak = 0, longest = 0;
  for (const r of rs) { if (r < 0) { streak += 1; longest = Math.max(longest, streak); } else streak = 0; }
  return {
    trades,
    winRate: trades ? +(wins / trades).toFixed(4) : 0,
    avgR: trades ? +(sum / trades).toFixed(4) : 0,
    expectancyR: trades ? +(sum / trades).toFixed(4) : 0,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : (grossWin > 0 ? Infinity : 0),
    totalR: +sum.toFixed(4),
    maxDrawdownR: +maxDD.toFixed(4),
    longestLosingStreak: longest,
  };
}

function groupBy(records, keyFn) {
  const g = {};
  for (const rec of records) { const k = keyFn(rec); (g[k] = g[k] || []).push(rec); }
  const out = {};
  for (const k of Object.keys(g)) out[k] = reduceStats(g[k].map((x) => x.r));
  return out;
}

/**
 * @param {Array} signals records with {status, pair, time, impulseOrigin, ...}
 * @param {object} opts { costR?: per-trade estimated cost in R (spread+slippage) }
 */
function computePerformance(signals, opts = {}) {
  const costR = opts.costR || 0;
  const realized = [];
  for (const s of signals) {
    const r = outcomeR(s.status);
    if (r == null) continue;                  // do not infer missing outcomes
    const perTradeCost = s.costR != null ? s.costR : costR;   // realistic cost in R (spread+slippage), per trade if provided
    realized.push({ ...s, r, rNet: r - perTradeCost, session: sessionOf(typeof s.time === 'number' ? s.time : new Date(s.time).getTime()), year: new Date(s.time).getUTCFullYear() });
  }

  const before = reduceStats(realized.map((x) => x.r));
  const after = reduceStats(realized.map((x) => x.rNet));

  return {
    totalSignals: signals.length,
    totalTrades: realized.length,
    ...before,
    beforeCosts: before,
    afterCosts: after,
    byPair: groupBy(realized, (x) => x.pair),
    byYear: groupBy(realized, (x) => x.year),
    bySession: groupBy(realized, (x) => x.session),
    byOrigin: groupBy(realized, (x) => x.impulseOrigin || 'UNKNOWN'),
  };
}

module.exports = { computePerformance, outcomeR, sessionOf, reduceStats };
