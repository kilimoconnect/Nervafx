'use strict';

/**
 * M15 Strategy Research — pure experiment runner (Stage 3). Steps a candidate over
 * a CHRONOLOGICAL sequence of as-of closes and produces deduplicated episodes with
 * a uniform lifecycle: start → (trigger) → expire | invalidate. The runner — not
 * the candidate — owns dedup/expiry/invalidation, so behaviour is uniform and
 * testable. Deterministic and read-only; produces NO actionable production signals.
 *
 * Episode ids are hashed over (pair, direction, FIRST close, ruleHash, params), so a
 * signal's timestamp is fixed at detection and cannot change after seeing outcomes.
 *
 * closes: [{ closeMs, ok, pairs: { pair: ctx } }]  (ctx = {pair, feat, net, prod, closeMs})
 *   ok:false ⇒ missing snapshot; a pair with no ctx / feat:null ⇒ incomplete ⇒ NO new action.
 */

const crypto = require('crypto');

function episodeId(pair, direction, firstCloseMs, ruleHash, params) {
  return crypto.createHash('sha256').update(`${pair}|${direction}|${firstCloseMs}|${ruleHash}|${JSON.stringify(params || {})}`).digest('hex').slice(0, 20);
}

function runCandidate(candidate, closes, opts = {}) {
  const params = opts.params || (candidate.variants && candidate.variants[0]) || {};
  const timeout = opts.timeoutCandles || 8;
  const open = {};                 // pair -> live episode
  const episodes = [];
  const counts = { started: 0, triggered: 0, expired: 0, invalidated: 0, dedupSkipped: 0, missingSkipped: 0, incompleteSkipped: 0 };

  const finish = (ep, endMs, reason) => { ep.endMs = endMs; ep.endReason = reason; episodes.push(ep); };

  for (const frame of closes) {
    if (!frame.ok) { counts.missingSkipped++; continue; }          // missing snapshot ⇒ no action
    for (const pair of Object.keys(frame.pairs)) {
      const ctx = frame.pairs[pair];
      const incomplete = !ctx || (candidate.family.startsWith('A') || candidate.family === 'B_continuation' ? !ctx.feat : false) || (candidate.readsFeatures.some((f) => f.startsWith('prod.')) && !ctx.prod);
      let d;
      if (incomplete) { counts.incompleteSkipped++; d = { arm: false, direction: null, trigger: false, invalidate: false, reasons: ['incomplete'] }; }
      else d = candidate.decide({ ...ctx, params });

      const ep = open[pair];
      if (!ep) {
        if (!incomplete && d.arm && d.direction) {
          const e = { candidate: candidate.id, ruleHash: candidate.ruleHash, pair, direction: d.direction, firstCloseMs: frame.closeMs, ageCandles: 1, state: 'ARMED', triggeredMs: null, reasons: d.reasons };
          e.id = episodeId(pair, d.direction, frame.closeMs, candidate.ruleHash, params);
          if (d.trigger) { e.state = 'TRIGGERED'; e.triggeredMs = frame.closeMs; counts.triggered++; }
          open[pair] = e; counts.started++;
        }
        continue;
      }
      // an episode is open for this pair
      ep.ageCandles++;
      if (d.invalidate || (d.arm && d.direction && d.direction !== ep.direction)) {
        finish(ep, frame.closeMs, d.invalidate ? 'invalidated' : 'reversed'); delete open[pair]; counts.invalidated++;
        // allow an immediate opposite start next close (not this one) — conservative
        continue;
      }
      if (ep.state === 'ARMED' && d.trigger && d.direction === ep.direction) { ep.state = 'TRIGGERED'; ep.triggeredMs = frame.closeMs; counts.triggered++; }
      else if (d.arm && d.direction === ep.direction) { counts.dedupSkipped++; }   // repeated arm ⇒ same episode
      if (ep.ageCandles > timeout) { finish(ep, frame.closeMs, ep.state === 'TRIGGERED' ? 'timeout_after_trigger' : 'expired'); delete open[pair]; counts.expired++; }
    }
  }
  for (const p of Object.keys(open)) finish(open[p], null, 'open_at_end');
  return { candidate: candidate.id, ruleHash: candidate.ruleHash, params, episodes, counts };
}

module.exports = { runCandidate, episodeId };
