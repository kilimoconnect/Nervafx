'use strict';

/**
 * Orchestration: raw H1 → (trend + entry candle series) → structural trend context →
 * engine → trades. Pure (no I/O). Timeframe-parameterized by a `tf` descriptor so the
 * SAME verified core serves both strategies:
 *   • W1→H4 (default): entry = H4 aggregate, trend = W1 aggregate.
 *   • D1→H1:           entry = H1 (direct),  trend = D1 aggregate.
 *
 * Gating modes (comparisons):
 *   • 'trend'  — the strategy: entry continuation gated by the higher-TF structural trend.
 *   • 'self'   — identical entry-TF setup with NO higher-TF filter (forced-eligible in
 *                BOTH directions). Targets still use higher-TF levels (held constant).
 * Baseline: a simple higher-TF price-structure continuation (enter on a completed
 * entry-TF close through the latest confirmed higher-TF swing in the trend direction).
 */

const agg = require('./aggregate');
const { buildWeeklyContext } = require('./weeklyTrend');
const { runEngine } = require('./engine');
const { simulateTrade } = require('./trade');

const TF_W1H4 = { entry: (h1, a) => agg.h4(h1, a), trend: (h1, a) => agg.w1(h1, a), entryLabel: 'H4', trendLabel: 'W1' };
const TF_D1H1 = { entry: (h1, a) => agg.h1AsOf(h1, a), trend: (h1, a) => agg.d1(h1, a), entryLabel: 'H1', trendLabel: 'D1' };

function forcedContext(bias, trendCtx) {
  return {
    biasAt: () => ({ bias, eligibilityStartMs: -Infinity, invalidationLevel: bias === 'BULLISH' ? -Infinity : Infinity }),
    levelsAsOf: trendCtx.levelsAsOf, episodes: [], pivots: [],
  };
}

function runStrategy(h1, pair, cfg, mode, tf) {
  tf = tf || TF_W1H4;
  const entry = tf.entry(h1, Infinity);
  const trend = tf.trend(h1, Infinity);
  const trendCtx = buildWeeklyContext(trend, cfg.swing);
  let opportunities = [];
  if (mode === 'self' || mode === 'h4self') {
    opportunities = opportunities.concat(runEngine(entry, forcedContext('BULLISH', trendCtx), Object.assign({}, cfg, { pair })).opportunities);
    opportunities = opportunities.concat(runEngine(entry, forcedContext('BEARISH', trendCtx), Object.assign({}, cfg, { pair })).opportunities);
    opportunities.sort((a, b) => a.signalCloseMs - b.signalCloseMs);
  } else {
    opportunities = runEngine(entry, trendCtx, Object.assign({}, cfg, { pair })).opportunities;
  }
  const trades = [];
  for (const opp of opportunities) {
    const levels = trendCtx.levelsAsOf(opp.signalCloseMs);
    const t = simulateTrade(opp, entry, levels, Object.assign({}, cfg, { pair }));
    t.gate = mode; t.pair = pair; t.signalCloseMs = opp.signalCloseMs;
    trades.push(t);
  }
  return { trades, opportunities, ctx: trendCtx, entry, trend };
}

function runTrendBaseline(h1, pair, cfg, tf) {
  tf = tf || TF_W1H4;
  const entry = tf.entry(h1, Infinity);
  const trend = tf.trend(h1, Infinity);
  const trendCtx = buildWeeklyContext(trend, cfg.swing);
  const trades = [];
  let activeEpisode = null;
  for (let j = 0; j < entry.length; j++) {
    const c = entry[j];
    const wk = trendCtx.biasAt(c.closeMs);
    if (wk.bias !== 'BULLISH' && wk.bias !== 'BEARISH') continue;
    if (wk.eligibilityStartMs === activeEpisode) continue;
    const lv = trendCtx.levelsAsOf(c.closeMs);
    const d = wk.bias === 'BULLISH' ? 1 : -1;
    const levelsDir = d > 0 ? lv.highs : lv.lows;
    if (!levelsDir.length) continue;
    const brk = d > 0 ? Math.max.apply(null, levelsDir) : Math.min.apply(null, levelsDir);
    if (d > 0 ? c.close > brk : c.close < brk) {
      const entryBar = entry[j + 1];
      const opp = { pair, dir: d > 0 ? 'BUY' : 'SELL', signalCloseMs: c.closeMs, signalBarIdx: j, stopRef: wk.invalidationLevel, pullbackExtreme: wk.invalidationLevel, entryBarIdx: entryBar ? j + 1 : null, entryOpenMs: entryBar ? entryBar.openMs : null, entryPrice: entryBar ? entryBar.open : null };
      const t = simulateTrade(opp, entry, lv, Object.assign({}, cfg, { pair }));
      t.gate = 'trend_baseline'; t.pair = pair; t.signalCloseMs = c.closeMs;
      trades.push(t);
      activeEpisode = wk.eligibilityStartMs;
    }
  }
  return { trades, entry, trend, ctx: trendCtx };
}

/** Back-compat helper used by the W1→H4 backtest audit. */
function aggregates(h1, asOfMs) { const asOf = asOfMs == null ? Infinity : asOfMs; return { h4: agg.h4(h1, asOf), w1: agg.w1(h1, asOf) }; }

module.exports = { TF_W1H4, TF_D1H1, forcedContext, aggregates, runStrategy, runTrendBaseline, runWeeklyBaseline: runTrendBaseline };
