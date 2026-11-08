'use strict';

/**
 * Signal-level statistics + performance reporting (spec §11, §12). Operates on the trade
 * records produced by lifecycle.buildTrade. All figures are MODELLED / estimated execution.
 *
 * Win rate = profitable resolved CLOSED trades / all resolved closed trades × 100 (pending,
 * open, expired, cancelled and unresolved are excluded from the denominator and disclosed
 * separately). Net R is size-independent; account returns live in portfolio.js.
 *
 * Closed-trade statistics are attributed to their EXIT period (disclosed convention).
 */

const BE_EPS = 1e-9;

/** Per-strategy stat block over a set of trades. */
function strategyStats(trades, entryMs) {
  const s = {
    published: trades.length, entered: 0, open: 0, closed: 0, expired: 0, cancelled: 0, unresolved: 0,
    wins: 0, losses: 0, breakeven: 0, ambiguous: 0, monitoredM5: 0, monitoredM15: 0,
    netRsum: 0, winRsum: 0, lossRsum: 0, holdCandlesSum: 0,
  };
  for (const t of trades) {
    switch (t.status) {
      case 'EXPIRED': s.expired++; break;
      case 'CANCELLED': s.cancelled++; break;
      case 'UNRESOLVED': s.entered++; s.unresolved++; break;
      case 'OPEN': s.entered++; s.open++; break;
      case 'CLOSED': {
        s.entered++; s.closed++;
        if (t.ambiguityFlag) s.ambiguous++;
        if (t.dataQuality && t.dataQuality.monitorTf === 'M5') s.monitoredM5++; else s.monitoredM15++;
        s.netRsum += t.netR;
        if (entryMs && t.exitMs != null && t.fillMs != null) s.holdCandlesSum += Math.max(1, Math.round((t.exitMs - t.fillMs) / entryMs));
        if (t.result === 'win') { s.wins++; s.winRsum += t.netR; }
        else if (t.result === 'loss') { s.losses++; s.lossRsum += t.netR; }
        else s.breakeven++;
        break;
      }
      default: break;
    }
  }
  const resolved = s.wins + s.losses + s.breakeven;
  s.winRate = resolved ? +(100 * s.wins / resolved).toFixed(1) : null;
  s.avgNetR = s.closed ? +(s.netRsum / s.closed).toFixed(4) : null;
  s.totalNetR = +s.netRsum.toFixed(4);
  s.avgWinR = s.wins ? +(s.winRsum / s.wins).toFixed(4) : null;
  s.avgLossR = s.losses ? +(s.lossRsum / s.losses).toFixed(4) : null;
  s.profitFactor = s.lossRsum < 0 ? +(s.winRsum / Math.abs(s.lossRsum)).toFixed(3) : (s.winRsum > 0 ? null : null);
  s.profitFactorNote = s.lossRsum < 0 ? null : (s.wins > 0 ? 'undefined (no losing trades)' : 'n/a (no wins)');
  s.avgHoldCandles = s.closed ? +(s.holdCandlesSum / s.closed).toFixed(1) : null;
  s.resolvedClosed = resolved;
  return s;
}

/** Group closed trades into UTC period buckets by EXIT time; returns sorted buckets with R sums. */
function byPeriod(trades, period) {
  const key = periodKeyFn(period);
  const map = new Map();
  for (const t of trades) {
    if (t.status !== 'CLOSED' || t.exitMs == null) continue;
    const k = key(t.exitMs);
    let b = map.get(k); if (!b) { b = { period: k, closed: 0, wins: 0, losses: 0, netR: 0 }; map.set(k, b); }
    b.closed++; b.netR += t.netR; if (t.result === 'win') b.wins++; else if (t.result === 'loss') b.losses++;
  }
  return [...map.values()].sort((a, b) => (a.period < b.period ? -1 : 1)).map((b) => ({ ...b, netR: +b.netR.toFixed(4), winRate: b.closed ? +(100 * b.wins / (b.wins + b.losses || 1)).toFixed(1) : null }));
}

function periodKeyFn(period) {
  if (period === 'daily') return (ms) => new Date(ms).toISOString().slice(0, 10);
  if (period === 'weekly') return (ms) => { const d = Math.floor(ms / 86400000) * 86400000; const back = (new Date(d).getUTCDay() + 6) % 7; return new Date(d - back * 86400000).toISOString().slice(0, 10); };
  if (period === 'monthly') return (ms) => new Date(ms).toISOString().slice(0, 7);
  throw new Error('unknown period: ' + period);
}

/** Breakdown of closed-trade net R by an arbitrary key fn (pair, direction, rank). */
function breakdown(trades, keyOf) {
  const map = new Map();
  for (const t of trades) {
    if (t.status !== 'CLOSED') continue;
    const k = keyOf(t);
    let b = map.get(k); if (!b) { b = { key: k, closed: 0, wins: 0, losses: 0, netR: 0 }; map.set(k, b); }
    b.closed++; b.netR += t.netR; if (t.result === 'win') b.wins++; else if (t.result === 'loss') b.losses++;
  }
  return [...map.values()].sort((a, b) => b.netR - a.netR).map((b) => ({ ...b, netR: +b.netR.toFixed(4), winRate: b.closed ? +(100 * b.wins / (b.wins + b.losses || 1)).toFixed(1) : null }));
}

const byPair = (trades) => breakdown(trades, (t) => t.signal.pair);
const byDirection = (trades) => breakdown(trades, (t) => t.signal.direction);
const byRank = (trades) => breakdown(trades, (t) => 'rank ' + t.signal.rank);
const byOrigin = (trades) => breakdown(trades, (t) => t.signal.origin || 'historical');

module.exports = { strategyStats, byPeriod, breakdown, byPair, byDirection, byRank, byOrigin, BE_EPS };
