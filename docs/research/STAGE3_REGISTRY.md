# M15 Strategy Research — Stage 3 handoff (pre-registered hypotheses)

A versioned experiment registry + pure candidate interface in the isolated research
namespace. Every candidate is **frozen and hashed over its declarative rules**, so a
threshold edit yields a new hash/version and never rewrites a registered rule in
place. Research candidates are pure and **never surface as actionable production
signals**. Built on Stage 1 (no-lookahead) + Stage 2 (features). **No winner claimed.**

- Research layer version **`m15-research-3.0.0`**. Registry: `research/m15/registry.js`,
  candidates `research/m15/candidates.js`, runner `research/m15/experiment.js`.
- Manifest (all rules + trace): `docs/research/stage3_registry.json`.
- Tests: `node --test tests/research/*.test.js` → **28 pass / 0 fail** (repo 167/167).

## Registry schema (per candidate)
`{ id, family, direction (WITH|AGAINST|NEUTRAL), hypothesis, entry, exit,
invalidation, timeout, eligibility, costAssumptions, params, paramBounds,
variants[], readsFeatures[], researchVersion, registeredAt, ruleHash, decide(ctx) }`
— `ruleHash = sha256(rules)`; the object is `Object.freeze`d; `decide` is a pure
function used by the generic lifecycle runner (which owns dedup/expiry/invalidation).

## Registered families (11 candidates, one change at a time)
| id | family | hypothesis (short) | entry gate | dir |
|---|---|---|---|---|
| A0_baseline_dir10 | A baseline | sign(R10) predicts next move | R10 sign (± z deadband) | WITH |
| A1_…_consistency | A | +movement consistency | \|P10\| ≥ consistMin | WITH |
| A2_plus_breadth | A | +currency breadth | breadth(base)−breadth(quote) ≥ breadthMin | WITH |
| A3_…_structure_energy | A | +energy alignment | prod energyDirection matches, not DEAD | WITH |
| B_continuation_4after10 | B | 4-bar push after meaningful 10-bar move | \|z10\|≥meaningfulZ ∧ sign(R4)=sign(R10) ∧ \|P4\|≥pressMin | WITH |
| C_early_expansion | C | early adaptive expansion out of balance | prod *_EXPANSION ∧ EARLY/ATTEMPTING ∧ not late | WITH |
| D_first_pullback | D | first controlled pullback resumes | prod *_PULLBACK ∧ isPullback ∧ not late | WITH |
| E_compression_release | E | compression release with building pressure | prod COMPRESSION ∧ ACTIVE/TIGHT/RELEASING ∧ pressure building | WITH |
| F_failed_extension | F | failed extension rotates opposite | prod FAILED_*_EXPANSION | **AGAINST** |
| CTRL_pseudo_random | control | null benchmark (hash→L/S/none) | deterministic pseudo-random | NEUTRAL |
| NULL_no_signal | control | do nothing | never | NEUTRAL |

**Lifecycle (uniform, runner-owned):** an episode **starts** when a candidate arms in
a direction; **triggers** on its entry condition; **remains valid** while conditions
hold and within `timeout` (default 8 M15 closes, B=6); **invalidates** on the
candidate's invalidation predicate or a direction reversal; **expires** at timeout.
Repeated arms in the same direction stay ONE episode (dedup). Exit is a fixed 2R
target / stop (outcome computed in Stage 4, not here).

**C–F reuse frozen production semantics** (`marketState`, `expansion`, `freshness`,
`compression`, `pressure`) read-only via `ctx.prod` (the production coordinator run at
the accepted `m15-cfg-1.1.0a`) — production logic is unchanged. EMA, wick shape,
acceleration, time-of-day and extension are **separate future hypotheses**, not stacked
into these.

## Feature-to-rule trace
Each candidate lists `readsFeatures` in `stage3_registry.json`, e.g. A2 reads
`horizons[10].R/P`, `net.breadth[base|quote].net`, `net.gap`; C reads
`prod.marketState.state`, `prod.expansion.state`, `prod.freshness.state`. No candidate
mixes independent + derived fields as separate confirmations (Stage 2 labelling).

## Variant budget (enumerated — constrained, not a search)
**15 total parameter variants** across 11 candidates: A0×2, A1×2, A2×2, A3×1, B×2,
C×1, D×1, E×1, F×1, CTRL×1, NULL×1. Every trial is listed in the manifest. **Thresholds
were chosen from first principles / prior production semantics — NOT from past win
rate, a desired alert volume, or inspecting the evaluation period.** A control
(pseudo-random) and a no-signal option bound spurious performance and activity.

## Examples (synthetic fixtures, from tests)
- A0: 3 closes R10=+0.004,+0.004,−0.004 ⇒ 1 episode started+triggered, 1 dedup, then reversed (invalidated).
- A2: R10 up but breadth spread 0 < breadthMin ⇒ **no episode** (conflicting/insufficient breadth).
- C: `prod` BULLISH_EXPANSION/EARLY/FRESH ⇒ armed; `prod:null` ⇒ incomplete ⇒ no action.
- Missing snapshot (`ok:false`) and incomplete candle (`feat:null`) ⇒ no new action.

## Acceptance — met
- **Replayable from frozen inputs:** `runCandidate` is pure/deterministic (two runs
  deep-equal), driven entirely by the supplied as-of contexts.
- **Parameter trials enumerated:** 15, all in the manifest.
- **Signal timestamps cannot change after outcomes:** episode id is hashed over
  `(pair, direction, FIRST close, ruleHash, params)`, fixed at detection; changing a
  rule changes the hash (new candidate), never the record.
- **Deterministic transition tests:** transitions, repeated-close dedup, conflicting
  currencies, identical evidence, missing snapshot, incomplete candle — all pass.

## Stage 4 readiness / handoff
Candidates are frozen and enumerated; the runner emits episodes with fixed
timestamps and lifecycle. Stage 4 should: run each candidate+variant over the
full-cadence history and a prospective/holdout split (declared before viewing
outcomes), apply the **Stage-1 cost caveat** (mid-only → model spread/slippage/
human-delay externally, label ambiguous M15 stop/target ordering as ambiguous),
compare every candidate against the **control** and **no-signal**, and report the
**full trial count** with denominators. **No winner is claimed here.** Stop after
Stage 3.
