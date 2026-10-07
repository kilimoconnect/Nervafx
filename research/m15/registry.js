'use strict';

/**
 * M15 Strategy Research — experiment registry (Stage 3). Pre-registers a LIMITED,
 * versioned set of strategy hypotheses. Every candidate is FROZEN and hashed over
 * its declarative RULES (not code), so a threshold change yields a new hash/version
 * and never edits a registered rule in place. Research candidates are pure and
 * NEVER surface as actionable production signals.
 *
 * A candidate declares WHAT it is (hypothesis, entry/exit/invalidation/timeout,
 * eligibility, cost assumptions, parameter bounds, enumerated variants, which
 * features it reads) and provides a pure `decide(ctx)` used by the generic
 * lifecycle runner (experiment.js). The runner — not the candidate — owns episode
 * dedup, expiry and invalidation, so lifecycle is uniform and testable.
 */

const crypto = require('crypto');

const RESEARCH_LAYER_VERSION = 'm15-research-3.0.0';

function stableStringify(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

/**
 * Freeze + hash a candidate spec. The hash covers only the RULES (declarative
 * fields), so identical rules ⇒ identical hash, and any rule edit ⇒ a new hash.
 * @param spec {
 *   id, family, hypothesis, direction ('WITH'|'AGAINST'|'NEUTRAL'),
 *   entry, exit, invalidation, timeout, eligibility, costAssumptions,
 *   params, paramBounds, variants[], readsFeatures[], registeredAt, decide(ctx)
 * }
 */
function defineCandidate(spec) {
  const rules = {
    family: spec.family, hypothesis: spec.hypothesis, direction: spec.direction || 'WITH',
    entry: spec.entry, exit: spec.exit, invalidation: spec.invalidation, timeout: spec.timeout,
    eligibility: spec.eligibility, costAssumptions: spec.costAssumptions,
    params: spec.params, paramBounds: spec.paramBounds, variants: spec.variants || [{}],
    readsFeatures: spec.readsFeatures || [],
  };
  const ruleHash = crypto.createHash('sha256').update(stableStringify(rules)).digest('hex').slice(0, 16);
  if (typeof spec.decide !== 'function') throw new Error(`candidate ${spec.id} missing decide()`);
  return Object.freeze({
    id: spec.id,
    researchVersion: RESEARCH_LAYER_VERSION,
    registeredAt: spec.registeredAt || '2026-09-27',
    ruleHash,
    variantCount: rules.variants.length,
    ...rules,
    decide: spec.decide,          // pure; not part of the hash (rules are)
  });
}

/** A registry: enumerates candidates, computes the variant budget, exports a manifest. */
function makeRegistry(candidates) {
  const byId = {};
  for (const c of candidates) { if (byId[c.id]) throw new Error(`duplicate candidate id ${c.id}`); byId[c.id] = c; }
  const totalVariants = candidates.reduce((s, c) => s + c.variantCount, 0);
  return {
    version: RESEARCH_LAYER_VERSION,
    candidates, byId,
    variantBudget: { candidates: candidates.length, totalParameterVariants: totalVariants },
    manifest() {
      return {
        researchVersion: RESEARCH_LAYER_VERSION,
        note: 'Pre-registered research hypotheses. Not actionable production signals. No winner claimed.',
        variantBudget: this.variantBudget,
        candidates: candidates.map((c) => ({
          id: c.id, family: c.family, direction: c.direction, hypothesis: c.hypothesis,
          entry: c.entry, exit: c.exit, invalidation: c.invalidation, timeout: c.timeout,
          eligibility: c.eligibility, costAssumptions: c.costAssumptions,
          params: c.params, paramBounds: c.paramBounds, variants: c.variants,
          readsFeatures: c.readsFeatures, ruleHash: c.ruleHash, registeredAt: c.registeredAt,
        })),
      };
    },
  };
}

module.exports = { RESEARCH_LAYER_VERSION, defineCandidate, makeRegistry, stableStringify };
