'use strict';

/**
 * M15 Intelligence — pair-ranking engine (§26).
 *
 * Ranks all 28 pairs after every M15 close by opportunity quality. Favours fresh
 * strength divergence, broad participation, strong-vs-weak power, early
 * expansion, rising energy, acceptable spread and adequate space; penalises
 * mature/overextended moves, chaotic energy, weak breadth, wide spread,
 * conflicting structure, insufficient space and stale data. Correlated duplicate
 * exposure is de-weighted in a second pass so several correlated pairs cannot all
 * top the board. Ranking first does NOT bypass the mandatory gates — `qualifies`
 * still requires an armed decision (§26). Pure & deterministic.
 */

const { CONFIG } = require('./config');
const { split } = require('./pairs');

const FRESH = { FRESH: 1.0, TRADEABLE: 0.8, DEVELOPING: 0.4, PREPARING: 0.3, LATE: -0.6, EXHAUSTED: -0.9 };

function scorePair(r, cfg) {
  let s = 0; const parts = {};
  const add = (k, v) => { parts[k] = +v.toFixed(3); s += v; };

  add('freshness', (FRESH[r.freshness?.state] ?? 0));
  const agr = r.agreement || {};
  const agrDir = /BULLISH/.test(agr.state) ? 1 : /BEARISH/.test(agr.state) ? -1 : 0;
  add('agreement', (/^STRONG_/.test(agr.state) ? 1 : /_BUILDING$/.test(agr.state) ? 0.6 : /^WEAK_/.test(agr.state) ? 0.3 : 0));
  add('strengthDivergence', Math.min(1, Math.abs(r.strengthDiff || 0) / 100));
  const bp = r.basePower?.powerScore || 0, qp = r.quotePower?.powerScore || 0;
  add('powerEdge', Math.min(1, Math.abs(bp - qp) / 100));
  add('expansion', r.expansion?.focus ? 0.6 : (r.expansion?.state === 'DEVELOPED' || r.expansion?.state === 'OVEREXTENDED') ? -0.6 : 0);
  add('energy', r.energy?.energyLevel === 'DEAD' ? -0.8 : r.energy?.energyDirection === 'CHAOTIC' ? -0.8 : r.energy?.energyAcceleration === 'RISING' ? 0.4 : 0);
  // Penalties
  if (r.spreadPips != null && r.spreadCapPips != null && r.spreadPips > r.spreadCapPips) add('spread', -0.7);
  if (r.expansion && r.expansion.spaceSufficient === false) add('space', -0.6);
  if (agr.state === 'CONFLICTED') add('conflict', -0.7);
  if (r.stale) add('stale', -1.0);

  return { score: +s.toFixed(3), agrDir, parts };
}

function rankPairs(pairResults, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const scored = pairResults.map((r) => {
    const { score, agrDir, parts } = scorePair(r, cfg);
    return { pair: r.pair, base: split(r.pair).base, quote: split(r.pair).quote, rawScore: score, agrDir, parts, qualifies: isArmed(r.decision), decision: r.decision };
  });

  // Correlation de-dup: once a currency is committed in a direction by a higher
  // pair, later pairs re-using it in the SAME direction are damped (§14/§26).
  scored.sort((a, b) => b.rawScore - a.rawScore);
  const committed = new Map(); // currency -> dir
  for (const s of scored) {
    let penalty = 0;
    if (s.agrDir !== 0) {
      const baseDir = committed.get(s.base), quoteDir = committed.get(s.quote);
      if (baseDir === s.agrDir) penalty += cfg.power.correlationDamp;
      if (quoteDir === -s.agrDir) penalty += cfg.power.correlationDamp;
    }
    s.score = +(s.rawScore - penalty).toFixed(3);
    s.correlationPenalty = +penalty.toFixed(3);
    if (s.agrDir !== 0) { committed.set(s.base, s.agrDir); committed.set(s.quote, -s.agrDir); }
  }

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}

function isArmed(decision) { return decision === 'ARMED_BULLISH' || decision === 'ARMED_BEARISH' || decision === 'MANUAL_BUY_OPPORTUNITY' || decision === 'MANUAL_SELL_OPPORTUNITY'; }

module.exports = { rankPairs, scorePair };
