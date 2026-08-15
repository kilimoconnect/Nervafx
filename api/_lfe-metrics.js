'use strict';

/**
 * NervaFX Liquidity Failure Engine — backtest metrics & grouping (Portion 8B/E/F).
 *
 * Pure aggregation over outcome records. Reports the four setup-direction
 * variants separately, slices by many dimensions, raises stability flags, and
 * compares sweep-alone vs H1-failure vs full H1+M15 to test whether the M15
 * confirmation earns its keep.
 */

const { CONFIG } = require('./_lfe-constants');

const round2 = (v) => (v === Infinity ? Infinity : Math.round(v * 100) / 100);
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function computeMetrics(outs) {
  const wins = outs.filter((o) => o.status === 'WIN');
  const losses = outs.filter((o) => o.status === 'LOSS');
  const rs = outs.map((o) => o.resultR);
  const sum = rs.reduce((a, b) => a + b, 0);
  const grossWin = wins.reduce((a, o) => a + o.resultR, 0);
  const grossLoss = Math.abs(losses.reduce((a, o) => a + o.resultR, 0));

  let eq = 0, peak = 0, mdd = 0;
  for (const o of outs) { eq += o.resultR; if (eq > peak) peak = eq; if (peak - eq > mdd) mdd = peak - eq; }

  let cw = 0, cl = 0, mw = 0, ml = 0;
  for (const o of outs) {
    if (o.status === 'WIN') { cw += 1; cl = 0; if (cw > mw) mw = cw; }
    else if (o.status === 'LOSS') { cl += 1; cw = 0; if (cl > ml) ml = cl; }
    else { cw = 0; cl = 0; }
  }
  const holds = outs.map((o) => o.holdingMs).filter((x) => x != null);

  return {
    count: outs.length,
    wins: wins.length,
    losses: losses.length,
    expired: outs.filter((o) => o.status === 'EXPIRED').length,
    winRate: outs.length ? round2(wins.length / outs.length) : 0,
    avgR: outs.length ? round2(sum / outs.length) : 0,
    medianR: round2(median(rs)),
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0),
    expectancy: outs.length ? round2(sum / outs.length) : 0,
    netR: round2(sum),
    maxDrawdownR: round2(mdd),
    maxConsecWins: mw,
    maxConsecLosses: ml,
    avgHoldingMs: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : 0,
  };
}

function groupBy(outs, keyFn) {
  const buckets = new Map();
  for (const o of outs) {
    const k = keyFn(o);
    if (k == null) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(o);
  }
  const out = {};
  for (const [k, arr] of buckets) out[k] = computeMetrics(arr);
  return out;
}

/** The four required setup-direction variants, reported separately. */
function variantKey(o) { return `${o.setupType}_${o.failedSide}`; } // e.g. IMMEDIATE_BUYERS

function scoreBand(score) {
  if (score == null) return 'unknown';
  if (score >= 85) return '85-100';
  if (score >= 75) return '75-84';
  if (score >= 65) return '65-74';
  return '<65';
}

function monthKey(ms) {
  if (ms == null) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${('0' + (d.getUTCMonth() + 1)).slice(-2)}`;
}

function backtestReport(outs, cfg) {
  cfg = cfg || CONFIG;
  return {
    overall: computeMetrics(outs),
    byVariant: groupBy(outs, variantKey),
    byClassification: groupBy(outs, (o) => o.classification),
    byPair: groupBy(outs, (o) => o.pair),
    bySession: groupBy(outs, (o) => o.session),
    byMonth: groupBy(outs, (o) => monthKey(o.entryMs)),
    byScoreBand: groupBy(outs, (o) => scoreBand(o.score)),
    byLevelType: groupBy(outs, (o) => o.levelType),
    byRotationAgreement: groupBy(outs, (o) => (o.rotationAgrees == null ? 'unknown' : (o.rotationAgrees ? 'agree' : 'disagree'))),
    byMarketEnergy: groupBy(outs, (o) => o.marketEnergyState || 'unknown'),
    flags: stabilityFlags(outs, cfg),
  };
}

/** Warn when results lean on one pair, one period, thin samples, or weak countertrend. */
function stabilityFlags(outs, cfg) {
  cfg = cfg || CONFIG;
  const flags = [];
  const v = cfg.validation;

  const totalPositive = outs.filter((o) => o.resultR > 0).reduce((a, o) => a + o.resultR, 0);
  if (totalPositive > 0) {
    const byPair = {};
    for (const o of outs) if (o.resultR > 0) byPair[o.pair] = (byPair[o.pair] || 0) + o.resultR;
    for (const [pair, r] of Object.entries(byPair)) {
      if (r / totalPositive > v.pairDominancePct) flags.push({ type: 'PAIR_DOMINANCE', pair, share: round2(r / totalPositive) });
    }
  }

  const totalNet = outs.reduce((a, o) => a + o.resultR, 0);
  if (totalNet > 0) {
    const byMonth = {};
    for (const o of outs) { const m = monthKey(o.entryMs); if (m) byMonth[m] = (byMonth[m] || 0) + o.resultR; }
    for (const [m, r] of Object.entries(byMonth)) {
      if (r / totalNet > v.periodDominancePct) flags.push({ type: 'PERIOD_DOMINANCE', period: m, share: round2(r / totalNet) });
    }
  }

  const variants = groupBy(outs, variantKey);
  for (const [k, m] of Object.entries(variants)) {
    if (m.count < v.minSample) flags.push({ type: 'SMALL_SAMPLE', group: k, count: m.count });
  }

  const cls = groupBy(outs, (o) => o.classification);
  if (cls.TREND_ALIGNED && cls.COUNTERTREND && cls.COUNTERTREND.avgR < cls.TREND_ALIGNED.avgR - v.countertrendWorseR) {
    flags.push({ type: 'COUNTERTREND_WORSE', trendAvgR: cls.TREND_ALIGNED.avgR, countertrendAvgR: cls.COUNTERTREND.avgR });
  }
  return flags;
}

/**
 * Compare confirmation stages. Each record carries a `mode` of
 * 'sweep' | 'h1' | 'full'. Establishes whether M15 confirmation adds value.
 */
function compareConfirmation(records) {
  return {
    sweepAlone: computeMetrics(records.filter((r) => r.mode === 'sweep')),
    h1Only: computeMetrics(records.filter((r) => r.mode === 'h1')),
    fullH1M15: computeMetrics(records.filter((r) => r.mode === 'full')),
  };
}

module.exports = {
  computeMetrics, groupBy, variantKey, scoreBand, monthKey,
  backtestReport, stabilityFlags, compareConfirmation,
};
