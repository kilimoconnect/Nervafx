'use strict';

/**
 * Multi-pair scan: evaluate the as-of state of EVERY pair under a strategy and rank
 * the "best pairs to trade" first. A pair is most actionable when it is ARMED with a
 * valid forward trade (R:R ≥ min using the frozen trigger/stop and the nearest
 * opposing higher-TF target); developing setups rank below; neutral/unavailable last.
 * Light summaries only (no candle arrays). Causal: uses only data knowable as-of t.
 */

const { buildWeeklyContext } = require('./weeklyTrend');
const { runEngine } = require('./engine');
const { simulateTrade } = require('./trade');
const { pipSize } = require('./config');

const STATE_SCORE = {
  ARMED: 50, TRIGGERED: 45, WAITING_FOR_RETEST_STRUCTURE: 30, FIRST_BREAK: 25,
  PULLBACK_ACTIVE: 15, WAITING_FOR_PULLBACK: 8, NEUTRAL: 2, CANCELLED: 1, EXPIRED: 1, UNAVAILABLE: 0,
};

function scanPair(h1, pair, cfg, tf, asOfMs) {
  const entry = tf.entry(h1, asOfMs);
  const trend = tf.trend(h1, asOfMs);
  const ctx = buildWeeklyContext(trend, cfg.swing);
  const wk = ctx.biasAt(asOfMs);
  const eng = runEngine(entry, ctx, Object.assign({}, cfg, { pair }));
  const st = eng.log.length ? eng.log[eng.log.length - 1] : null;
  const state = st ? st.state : 'UNAVAILABLE';
  const dir = st ? st.dir : null;

  // Prospective forward trade for an ARMED pair (entry would be the next close beyond
  // the trigger): hypothetical R:R from trigger→stop and the nearest opposing target.
  let prospect = null;
  if (st && st.state === 'ARMED' && st.trigger != null && st.stopRef != null && dir) {
    const d = dir === 'BUY' ? 1 : -1, pip = pipSize(pair), ex = cfg.execution;
    const stop = st.stopRef - d * ex.bufferPips * pip;
    const lv = ctx.levelsAsOf(asOfMs);
    let target = null;
    if (d > 0) { const a = lv.highs.filter((x) => x > st.trigger); if (a.length) target = Math.min.apply(null, a); }
    else { const b = lv.lows.filter((x) => x < st.trigger); if (b.length) target = Math.max.apply(null, b); }
    if (target != null) {
      const risk = Math.abs(st.trigger - stop), reward = Math.abs(target - st.trigger);
      const exitCost = (ex.spreadPips / 2 + ex.slippagePips + ex.commissionPips) * pip;
      const rr = risk > 0 ? (reward - exitCost) / risk : 0;
      prospect = { dir, trigger: st.trigger, stop, target, rr: +rr.toFixed(2), riskPips: +(risk / pip).toFixed(1), rewardPips: +(reward / pip).toFixed(1), ok: rr >= cfg.minRewardRisk };
    }
  }

  // Most recent emitted opportunity (historical context / recency).
  const lastOpp = eng.opportunities.length ? eng.opportunities[eng.opportunities.length - 1] : null;
  let last = null;
  if (lastOpp) {
    const t = simulateTrade(lastOpp, entry, ctx.levelsAsOf(lastOpp.signalCloseMs), Object.assign({}, cfg, { pair }));
    last = { signalMs: lastOpp.signalCloseMs, dir: lastOpp.dir, accepted: !!t.accepted, rr: t.rrPlanned != null ? +t.rrPlanned.toFixed(2) : null, R: t.R != null ? t.R : null, reason: t.rejectReason || null };
  }

  let score = STATE_SCORE[state] || 0;
  if (prospect && prospect.ok) score += 10 + prospect.rr * 5;   // ARMED with a valid trade floats to the very top

  return { pair, bias: wk.bias, state, dir, cancelReason: st ? st.cancelReason : null, prospect, last, score: +score.toFixed(2) };
}

function scanAll(h1byPair, pairs, cfg, tf, asOfMs) {
  const rows = [];
  for (const p of pairs) {
    const h1 = h1byPair[p];
    if (!h1 || !h1.length) { rows.push({ pair: p, bias: 'UNAVAILABLE', state: 'UNAVAILABLE', dir: null, prospect: null, last: null, score: -1 }); continue; }
    try { rows.push(scanPair(h1, p, cfg, tf, asOfMs)); }
    catch (e) { rows.push({ pair: p, bias: 'UNAVAILABLE', state: 'ERROR', dir: null, prospect: null, last: null, score: -1, error: String(e && e.message || e) }); }
  }
  rows.sort((a, b) => (b.score - a.score) || a.pair.localeCompare(b.pair));
  return rows;
}

module.exports = { scanPair, scanAll };
