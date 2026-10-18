'use strict';

/**
 * Orchestration: raw H1 → (W1 + H4 aggregates) → weekly context → engine → trades.
 * Pure (no I/O). Used by the backtest and the as-of UI frame builder.
 *
 * Gating modes (for the required comparisons, step 10):
 *   • 'weekly' — the strategy: H4 continuation gated by the W1 structural trend.
 *   • 'h4self' — identical H4 setup with NO weekly filter (direction/eligibility
 *     taken from H4's own last-two-swing structure). Targets still use weekly levels
 *     so trade management is held constant.
 * Baseline (step 10.2): a simple weekly price-structure continuation (enter on a
 * completed H4 close through the latest confirmed weekly swing in the trend
 * direction; stop at the weekly structural level; same trade sim).
 */

const agg = require('./aggregate');
const { buildWeeklyContext } = require('./weeklyTrend');
const { runEngine } = require('./engine');
const { simulateTrade } = require('./trade');
const { confirmedAsOf } = require('./swings');

function aggregates(h1, asOfMs) {
  const asOf = asOfMs == null ? Infinity : asOfMs;
  return { h4: agg.h4(h1, asOf), w1: agg.w1(h1, asOf) };
}

/** A context that is permanently eligible in one direction (no trend filter). */
function forcedContext(bias, weekly) {
  return {
    biasAt: () => ({ bias, eligibilityStartMs: -Infinity, invalidationLevel: bias === 'BULLISH' ? -Infinity : Infinity }),
    levelsAsOf: weekly.levelsAsOf, episodes: [], pivots: [],
  };
}

/**
 * The strategy ('weekly') or the no-weekly-filter comparison ('h4self').
 *   • weekly  — gate the H4 continuation by the W1 structural trend.
 *   • h4self  — identical H4 setup with NO trend filter: run it forced-eligible in
 *               BOTH directions (a down-pullback→up-break is a long; the mirror a
 *               short). Targets still come from weekly structure (held constant).
 */
function runStrategy(h1, pair, cfg, mode) {
  const { h4, w1 } = aggregates(h1);
  const weekly = buildWeeklyContext(w1, cfg.swing);
  let opportunities = [];
  if (mode === 'h4self') {
    opportunities = opportunities.concat(runEngine(h4, forcedContext('BULLISH', weekly), Object.assign({}, cfg, { pair })).opportunities);
    opportunities = opportunities.concat(runEngine(h4, forcedContext('BEARISH', weekly), Object.assign({}, cfg, { pair })).opportunities);
    opportunities.sort((a, b) => a.signalCloseMs - b.signalCloseMs);
  } else {
    opportunities = runEngine(h4, weekly, Object.assign({}, cfg, { pair })).opportunities;
  }
  const trades = [];
  for (const opp of opportunities) {
    const levels = weekly.levelsAsOf(opp.signalCloseMs);     // targets always from weekly structure
    const t = simulateTrade(opp, h4, levels, Object.assign({}, cfg, { pair }));
    t.gate = mode; t.pair = pair; t.signalCloseMs = opp.signalCloseMs;
    trades.push(t);
  }
  return { trades, opportunities, ctx: weekly, h4, w1 };
}

/** Baseline B: weekly price-structure continuation (no H4 pullback refinement). */
function runWeeklyBaseline(h1, pair, cfg) {
  const { h4, w1 } = aggregates(h1);
  const weekly = buildWeeklyContext(w1, cfg.swing);
  const trades = [];
  let activeEpisode = null;     // eligibilityStartMs we have already traded
  for (let j = 0; j < h4.length; j++) {
    const c = h4[j];
    const wk = weekly.biasAt(c.closeMs);
    if (wk.bias !== 'BULLISH' && wk.bias !== 'BEARISH') { continue; }
    if (wk.eligibilityStartMs === activeEpisode) continue;   // one baseline trade per eligibility episode
    const lv = weekly.levelsAsOf(c.closeMs);
    const d = wk.bias === 'BULLISH' ? 1 : -1;
    // break of the latest confirmed weekly swing in the trend direction
    const levelsDir = d > 0 ? lv.highs : lv.lows;
    if (!levelsDir.length) continue;
    const brk = d > 0 ? Math.max.apply(null, levelsDir) : Math.min.apply(null, levelsDir);
    if (d > 0 ? c.close > brk : c.close < brk) {
      const entryBar = h4[j + 1];
      const opp = {
        pair, dir: d > 0 ? 'BUY' : 'SELL', signalCloseMs: c.closeMs, signalBarIdx: j,
        stopRef: wk.invalidationLevel, pullbackExtreme: wk.invalidationLevel,
        entryBarIdx: entryBar ? j + 1 : null, entryOpenMs: entryBar ? entryBar.openMs : null,
        entryPrice: entryBar ? entryBar.open : null,
      };
      const t = simulateTrade(opp, h4, weekly.levelsAsOf(c.closeMs), Object.assign({}, cfg, { pair }));
      t.gate = 'weekly_baseline'; t.pair = pair; t.signalCloseMs = c.closeMs;
      trades.push(t);
      activeEpisode = wk.eligibilityStartMs;
    }
  }
  return { trades, h4, w1, ctx: weekly };
}

module.exports = { aggregates, runStrategy, runWeeklyBaseline };
