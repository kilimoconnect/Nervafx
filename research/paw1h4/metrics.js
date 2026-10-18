'use strict';

/**
 * Backtest metrics over a set of simulated trades (step 10). R is the per-trade
 * result in units of initial risk. Only ACCEPTED trades with a realized exit count
 * toward performance; rejections are tallied by reason. Economics are mid-only /
 * estimated — labelled as such by the caller.
 */

function monthKey(ms) { const d = new Date(ms); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

function computeMetrics(trades) {
  const accepted = trades.filter((t) => t.accepted && t.R != null && !t.pending);
  const rejected = trades.filter((t) => !t.accepted);
  const rejectByReason = {};
  for (const t of rejected) rejectByReason[t.rejectReason] = (rejectByReason[t.rejectReason] || 0) + 1;

  const Rs = accepted.map((t) => t.R);
  const wins = Rs.filter((r) => r > 0), losses = Rs.filter((r) => r <= 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));
  const expectancyR = Rs.length ? sum(Rs) / Rs.length : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // Equity curve in R → max drawdown (in R).
  let peak = 0, equity = 0, maxDD = 0;
  const ordered = accepted.slice().sort((a, b) => (a.exit.ms - b.exit.ms));
  for (const t of ordered) { equity += t.R; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDD) maxDD = dd; }

  // Longest losing streak.
  let streak = 0, maxStreak = 0;
  for (const t of ordered) { if (t.R <= 0) { streak++; if (streak > maxStreak) maxStreak = streak; } else streak = 0; }

  const avgHold = accepted.length ? sum(accepted.map((t) => t.barsHeld)) / accepted.length : 0;

  // Concentration.
  const byPair = {}, byMonth = {};
  for (const t of accepted) {
    byPair[t.pair] = byPair[t.pair] || { n: 0, R: 0 };
    byPair[t.pair].n++; byPair[t.pair].R += t.R;
    const mk = monthKey(t.signalCloseMs);
    byMonth[mk] = byMonth[mk] || { n: 0, R: 0 };
    byMonth[mk].n++; byMonth[mk].R += t.R;
  }

  // Overlapping exposure: max concurrent open trades (entry → exit intervals).
  const events = [];
  for (const t of accepted) { if (t.entryOpenMs != null && t.exit) { events.push([t.entryOpenMs, 1]); events.push([t.exit.ms, -1]); } }
  events.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  let open = 0, maxConcurrent = 0;
  for (const e of events) { open += e[1]; if (open > maxConcurrent) maxConcurrent = open; }

  const ambiguous = accepted.filter((t) => t.ambiguous).length;

  return {
    opportunities: trades.length,
    accepted: accepted.length,
    rejected: rejected.length, rejectByReason,
    wins: wins.length, losses: losses.length,
    winRate: Rs.length ? +(wins.length / Rs.length).toFixed(4) : 0,
    expectancyR: +expectancyR.toFixed(4),
    totalR: +sum(Rs).toFixed(4),
    profitFactor: profitFactor === Infinity ? 'inf' : +profitFactor.toFixed(4),
    maxDrawdownR: +maxDD.toFixed(4),
    maxLosingStreak: maxStreak,
    avgHoldBars: +avgHold.toFixed(2),
    ambiguousExits: ambiguous,
    maxConcurrentExposure: maxConcurrent,
    concentrationByPair: byPair,
    concentrationByMonth: byMonth,
  };
}

module.exports = { computeMetrics, monthKey };
