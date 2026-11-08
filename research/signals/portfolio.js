'use strict';

/**
 * Model-portfolio accounting (spec §11, §12). Marks equity to market from modelled fills
 * and exits; NOT a real account.
 *
 * Account return is conversion-free: risk per trade is a % of CURRENT equity and net R is a
 * dimensionless multiple of that risk, so a closed trade moves equity by
 * riskAmount × netR where riskAmount = riskPct% × equityAtEntry. (An indicative lot size is
 * computed separately for display; it is not needed for the equity curve.) Account return =
 * endEquity / startEquity − 1, assuming no external cash flows. Overlapping trades each take
 * their risk at their own entry; P&L realises at each exit. Open-risk limits bound concurrency.
 *
 *   - independent portfolio: one strategy's entered trades only.
 *   - combined portfolio: all strategies under SHARED limits + conflict rules —
 *       * never a second position in a pair already open/pending,
 *       * opposite-direction signals for the same pair at the same time → skip BOTH (conflict),
 *       * other capacity conflicts resolved by rank → strategy key → pair symbol,
 *       * aggregate open risk ≤ maxAggregate, per-currency open risk ≤ maxPerCurrency.
 * Portfolio-skipped signals are recorded (their independent signal outcomes are untouched).
 */

const STRAT_ORDER = { today: 0, week: 1, month: 2 };

/** Only entered trades participate (status OPEN/CLOSED/UNRESOLVED); others never take risk. */
function entered(t) { return t.status === 'CLOSED' || t.status === 'OPEN' || t.status === 'UNRESOLVED'; }

/**
 * Simulate a portfolio.
 *   trades: array of lifecycle trades (each with .signal). For combined, from all strategies.
 *   params: { initialEquity, riskPerTradePct, maxAggregateRiskPct, maxPerCurrencyRiskPct }
 *   opts.combined: apply cross-pair conflict + shared limits (default false = independent).
 * Returns { equityCurve, finalEquity, accountReturnPct, maxDrawdownPct, realizedR,
 *           closed, openAtEnd, skipped[] }.
 */
function simulate(trades, params, opts = {}) {
  const riskPct = params.riskPerTradePct / 100;
  const maxAgg = params.maxAggregateRiskPct / 100;
  const maxCcy = params.maxPerCurrencyRiskPct / 100;
  const combined = !!opts.combined;

  // Build a chronological list of entries. Ties resolved by rank → strategy → symbol.
  const cands = trades.filter(entered).map((t) => ({ t, fillMs: t.fillMs, exitMs: t.exitMs == null ? Infinity : t.exitMs }));
  cands.sort((a, b) => a.fillMs - b.fillMs
    || (a.t.signal.rank - b.t.signal.rank)
    || ((STRAT_ORDER[a.t.signal.strategyKey] ?? 9) - (STRAT_ORDER[b.t.signal.strategyKey] ?? 9))
    || (a.t.signal.pair < b.t.signal.pair ? -1 : 1));

  let equity = params.initialEquity;
  const openByPair = new Map();      // pair -> {dir, riskAmount}
  const openList = [];               // {exitMs, pair, ccyA, ccyB, riskAmount, netR}
  const curve = [{ ms: cands.length ? cands[0].fillMs : 0, equity }];
  const skipped = [];
  let peak = equity, maxDD = 0, realizedR = 0, closed = 0;

  // Pre-detect simultaneous opposite-direction conflicts on the same pair (combined only).
  const conflictAt = new Set();
  if (combined) {
    const byPairTime = new Map();
    for (const c of cands) { const k = c.t.signal.pair + '@' + c.fillMs; (byPairTime.get(k) || byPairTime.set(k, []).get(k)).push(c); }
    for (const [k, list] of byPairTime) { if (list.length > 1 && new Set(list.map((x) => x.t.signal.direction)).size > 1) { conflictAt.add(k); for (const c of list) c._conflict = true; } }
  }

  // Merge entries and exits on a timeline.
  const events = [];
  for (const c of cands) { events.push({ ms: c.fillMs, kind: 'enter', c }); }
  // exits added as trades are admitted (we know exitMs up front for closed trades)

  function releaseExpired(nowMs) {
    for (let i = openList.length - 1; i >= 0; i--) {
      const o = openList[i];
      if (o.exitMs <= nowMs) {
        equity += o.riskAmount * (o.netR == null ? 0 : o.netR);
        realizedR += (o.netR == null ? 0 : o.netR);
        if (o.netR != null) closed++;
        openByPair.delete(o.pair);
        openList.splice(i, 1);
        peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak > 0 ? (peak - equity) / peak : 0);
        curve.push({ ms: o.exitMs, equity });
      }
    }
  }

  function currencyRisk(ccy) { let r = 0; for (const o of openList) if (o.ccyA === ccy || o.ccyB === ccy) r += o.riskAmount; return r; }

  for (const c of cands) {
    releaseExpired(c.fillMs);                       // realise anything that exited before this entry
    const sig = c.t.signal, pair = sig.pair, [ccyA, ccyB] = pair.split('_');

    if (combined && c._conflict) { skipped.push({ pair, strategy: sig.strategyKey, reason: 'opposite-direction conflict (same pair, same time)', ms: c.fillMs }); continue; }
    if (combined && openByPair.has(pair)) { skipped.push({ pair, strategy: sig.strategyKey, reason: 'pair already open/pending', ms: c.fillMs }); continue; }

    const riskAmount = riskPct * equity;
    if (combined) {
      const aggOpen = openList.reduce((s, o) => s + o.riskAmount, 0);
      if (aggOpen + riskAmount > maxAgg * equity + 1e-9) { skipped.push({ pair, strategy: sig.strategyKey, reason: 'aggregate open-risk limit', ms: c.fillMs }); continue; }
      if (currencyRisk(ccyA) + riskAmount > maxCcy * equity + 1e-9 || currencyRisk(ccyB) + riskAmount > maxCcy * equity + 1e-9) { skipped.push({ pair, strategy: sig.strategyKey, reason: 'per-currency open-risk limit', ms: c.fillMs }); continue; }
    }

    const netR = c.t.status === 'CLOSED' ? c.t.netR : null;   // open/unresolved contribute 0 at end
    openByPair.set(pair, true);
    openList.push({ exitMs: c.exitMs, pair, ccyA, ccyB, riskAmount, netR });
    curve.push({ ms: c.fillMs, equity });
  }
  releaseExpired(Infinity);                         // realise all remaining closed trades

  const openAtEnd = openList.length;                // open-at-dataset-end (kept open; not realised)
  curve.sort((a, b) => a.ms - b.ms);
  return {
    equityCurve: curve,
    finalEquity: +equity.toFixed(2),
    accountReturnPct: +((equity / params.initialEquity - 1) * 100).toFixed(3),
    maxDrawdownPct: +(maxDD * 100).toFixed(3),
    realizedR: +realizedR.toFixed(4),
    closed, openAtEnd, skipped,
  };
}

module.exports = { simulate };
