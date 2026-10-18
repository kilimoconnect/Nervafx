'use strict';

/**
 * As-of frame builder for the research UI and replay. Given raw H1 for one pair and
 * an evaluation time t, returns everything the view needs, using ONLY information
 * knowable by t (aggregates completed ≤ t, pivots confirmed ≤ t, engine run to t).
 * No invented confidence or profitability labels.
 */

const agg = require('./aggregate');
const { buildWeeklyContext } = require('./weeklyTrend');
const { runEngine } = require('./engine');
const { simulateTrade } = require('./trade');
const { confirmedAsOf } = require('./swings');
const { pipSize } = require('./config');

const EAT = (ms) => new Date(ms + 3 * 3600000).toISOString().replace('.000Z', ' EAT').replace('T', ' ');
const iso = (ms) => (ms == null || !isFinite(ms) ? null : new Date(ms).toISOString());

const TF_W1H4 = { entry: (h1, a) => agg.h4(h1, a), trend: (h1, a) => agg.w1(h1, a), entryLabel: 'H4', trendLabel: 'W1' };

function buildFrame(h1, pair, asOfMs, cfg, tf) {
  tf = tf || TF_W1H4;
  const h4 = tf.entry(h1, asOfMs);       // entry-TF candles (H4 or H1)
  const w1 = tf.trend(h1, asOfMs);       // trend-TF candles (W1 or D1)
  const weekly = buildWeeklyContext(w1, cfg.swing);
  const wk = weekly.biasAt(asOfMs);
  const eng = runEngine(h4, weekly, Object.assign({}, cfg, { pair }));
  const state = eng.log.length ? eng.log[eng.log.length - 1] : null;
  const lastOpp = eng.opportunities.length ? eng.opportunities[eng.opportunities.length - 1] : null;

  let suggested = null;
  if (lastOpp) {
    const lv = weekly.levelsAsOf(lastOpp.signalCloseMs);
    suggested = simulateTrade(lastOpp, h4, lv, Object.assign({}, cfg, { pair }));
  }

  const recentPartial = h4.slice(-24).filter((c) => c.partial).length;
  const w1conf = confirmedAsOf(weekly.pivots, asOfMs);

  return {
    strategyId: cfg.strategyId, version: cfg.version, pair,
    trendLabel: tf.trendLabel, entryLabel: tf.entryLabel,
    asOfUtc: iso(asOfMs), asOfEat: EAT(asOfMs),
    weekly: {
      bias: wk.bias,
      eligibilityStartUtc: iso(wk.eligibilityStartMs), eligibilityStartEat: wk.eligibilityStartMs && isFinite(wk.eligibilityStartMs) ? EAT(wk.eligibilityStartMs) : null,
      invalidationLevel: wk.invalidationLevel,
      lastHighs: (wk.highs || []).map((p) => ({ price: p.price, extremeUtc: iso(p.extremeTimeMs), confirmedUtc: iso(p.confirmedAtMs) })),
      lastLows: (wk.lows || []).map((p) => ({ price: p.price, extremeUtc: iso(p.extremeTimeMs), confirmedUtc: iso(p.confirmedAtMs) })),
    },
    h4: {
      state: state ? state.state : 'UNAVAILABLE', dir: state ? state.dir : null,
      breakLevel: state ? state.breakLevel : null,
      pullbackExtreme: state ? state.pullbackExtreme : null,
      firstBreakUtc: state && state.firstBreakMs ? iso(state.firstBreakMs) : null,
      trigger: state ? state.trigger : null, stopRef: state ? state.stopRef : null,
      armedUtc: state && state.armedAtMs ? iso(state.armedAtMs) : null,
      cancelReason: state ? state.cancelReason : null,
    },
    lastOpportunity: lastOpp ? {
      dir: lastOpp.dir, signalUtc: iso(lastOpp.signalCloseMs), signalEat: EAT(lastOpp.signalCloseMs),
      trigger: lastOpp.trigger, stopRef: lastOpp.stopRef, entryOpenUtc: iso(lastOpp.entryOpenMs), entryPrice: lastOpp.entryPrice,
    } : null,
    suggestedTrade: suggested && suggested.accepted ? {
      dir: suggested.dir, entryFill: suggested.entryFill, stop: suggested.stop, target: suggested.target,
      riskPips: +((suggested.riskPrice) / pipSize(pair)).toFixed(1),
      rewardPips: +((suggested.rewardPrice) / pipSize(pair)).toFixed(1),
      rewardRisk: +suggested.rrPlanned.toFixed(2),
      exit: suggested.exit ? { reason: suggested.exit.reason, utc: iso(suggested.exit.ms) } : null,
      R: suggested.R, ambiguous: suggested.ambiguous,
    } : null,
    rejection: suggested && !suggested.accepted ? { reason: suggested.rejectReason, rewardRisk: suggested.rrPlanned != null ? +suggested.rrPlanned.toFixed(2) : null } : null,
    expiryH4Bars: cfg.expiryH4Bars,
    dataQuality: {
      h4Count: h4.length, w1Count: w1.length,
      w1Confirmed: w1conf.length, recentH4Partial: recentPartial,
      warning: recentPartial > 0 ? `${recentPartial} of the last 24 H4 candles are partial (fewer than 4 H1) — around weekends/holidays; high/low are real, not fabricated.` : null,
    },
    // compact chart data (completed candles only, as-of t)
    h4candles: h4.slice(-120).map((c) => ({ t: c.openMs, o: c.open, h: c.high, l: c.low, c: c.close, partial: c.partial })),
    w1candles: w1.slice(-40).map((c) => ({ t: c.openMs, o: c.open, h: c.high, l: c.low, c: c.close, partial: c.partial })),
    h4pivots: confirmedAsOf(eng.pivots, asOfMs).slice(-30).map((p) => ({ type: p.type, price: p.price, extremeMs: p.extremeTimeMs, confirmedMs: p.confirmedAtMs })),
    w1pivots: w1conf.slice(-16).map((p) => ({ type: p.type, price: p.price, extremeMs: p.extremeTimeMs, confirmedMs: p.confirmedAtMs })),
  };
}

module.exports = { buildFrame, TF_W1H4 };
