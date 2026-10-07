# Stage 5A — correctness audit of the Stage 5 result

Read-only audit. No signal rules/thresholds changed, no scheduler, no SQL applied, no
push/deploy/broker. One proven correctness defect found and fixed (time axis); the
economic conclusion is re-verified against a preserved immutable baseline.

**Final decision: STAGE5_RECALCULATION_REQUIRED → recalculated → NONE_PASSED survives.**
Preserved baseline: `docs/research/audit/stage5_baseline_manifest.json`
(+`stage5_scorecard_PRESERVED.json`); corrected: `…/stage5_scorecard_CORRECTED.json`.

## 1. Time axis — DEFECT (fixed)
`scripts/research/audit-timeaxis.js` (real data, 2026-08-25→09-25):
| Metric | Value |
|---|---|
| Reported "closes" | **3,056** |
| **Distinct source frames** | **2,287** |
| Stale re-evaluations (frame older than close) | **769 (25%)** |
| Max times ONE frame re-evaluated | **193** (a Friday, across the weekend) |

Cause: the research driver used `syncAsOf(hist, T)` with **no `frameOpen+15===T` guard**,
so every weekend/gap T-step returned the same last Friday frame and was counted again —
inflating closes and episode counts. 2,287 ≈ the auditor's 24×96=2,304 weekday estimate,
so **~2,287 is the true unique-close denominator**. **Fix:** `if (evalMs + M15 !== T)
continue;` (matches the Stage-4 snapshot writer). Regression test added
(`tests/research/loader.test.js` — weekend T-steps proven stale). Re-run: **2,287 closes,
64,036 pair-at-close evals**. Never used forward-fill/synthetic/retro-complete; stale
frames are excluded, not filled.

## 2. Episode denominators — reconciled
`stage4_episodes.json` records = **all runs summed** (11 candidates × their variants),
not unique-per-candidate. Post-fix per-candidate totals (both A0 variants) drop with the
stale frames (e.g. A0 filled 10,971, essentially unchanged; total episodes fall as
weekend re-arm cycles are removed). Dedup holds: within an open episode, repeated same-
direction arms are deduped; a reversal/timeout closes it; one research position per pair.
The pre-fix "20,575 OOS A0" conflated **both variants' eval-split** filled records — a
reporting artifact of grouping variants together (see item 5). Corrected scorecard is in
`stage5_scorecard_CORRECTED.json`.

## 3. Leakage & coverage — caveats (no leakage in the decision path)
- Calibration/eval split is **by date at 50%** with a **1-hour embargo**. The decision
  uses the **reference trade** whose hold is **≤4 candles (1h)** → 1h embargo covers it.
  The forward **4/6/8/10-bar (up to 2.5h) accuracy is descriptive only**, not in the
  decision; it is *not* embargo-covered and must not be read as OOS economics.
- **Coverage limitation:** only **one month (2026-08-25→09-25)** was evaluated, NOT the
  full verified May 2025–Sep 2026 range (command exists: `--from 2025-05-19`). The prior
  Jul–11 Sep history is development/exploratory, not a pristine holdout. **This one-month
  scope, and its few week-blocks, is the main reason to treat the result as
  INSUFFICIENT/none-passed rather than a confident generalization.**
- All 28 pairs at one UTC close share a fold (folds are by date); selection uses only
  calibration net R, never evaluation outcomes.

## 4. Costs & control — explained (spot-checked)
All candidates ≈ the control (**CTRL −0.30R**) because none has directional edge
(accuracy ~0.46–0.50 ≈ coin flip): every strategy then inherits the same **structural
negative** — entry pays spread, exits are stop(−1R) or ~flat 1h-timeout, so expected net
≈ −(spread + stop/timeout asymmetry). CTRL uses the **same opportunity times and
pair/session exposures** (seeded hash per pair+close). Verified in the outcome fixtures:
stop/exit ordering, gap-through-stop at the worse open, same-bar touch → conservative
stop, no double-charged spread, ATR risk denominator. **UNVERIFIED caveat:** spread is
MODELLED (mid-only data) — net economics are estimates, not confirmed.

## 5. Statistics — inconsistency reconciled
The table's **OOS A-ladder (−0.319, −0.262, −0.250, −0.515)** is the **evaluation-split,
per-fill** mean; the handoff's **incremental ladder (−0.32, −0.31, −0.32, −0.27)** is the
**full-window, per-fill** mean of the selected variant — **different cohorts, not an
error**; now labelled as such. A3's −0.515 is a small OOS n (~148) → wide CI, low
confidence. Positive-week share was **0%** for every candidate. With ~4–5 week-blocks the
block-bootstrap CIs are **wide and low-confidence** — reported, not over-generalized.
Metrics kept distinct: mean net R per fill (reported) vs total net R vs equal-week.
Direction accuracy is **gross** (mid), separate from net economics; coin-flip accuracy
alone does not imply expectancy (costs make it negative).

## Reconciliation table
| Item | Baseline (pre-fix) | Corrected (post-fix) |
|---|---|---|
| Closes | 3,056 | **2,287** (distinct frames) |
| Pair-at-close evals | 85,568 | **64,036** |
| Stale re-evals | 769 (hidden) | **0** (skipped) |
| A0 filled | 10,972 | 10,971 |
| Conclusion | NONE PASSED | **NONE PASSED** |
| Economics (net R) | all negative | **all negative (≈ unchanged)** |

## Commands / results
```bash
node scripts/research/audit-timeaxis.js                 # 3056 vs 2287 distinct; 769 stale; max 193
node --test tests/research/*.test.js                    # 52 pass / 0 fail (incl. 5A regression)
node scripts/research/backtest-run.js --from 2026-08-25 --to 2026-09-25   # corrected: 2287 closes
node scripts/research/stage5-compare.js                 # CONCLUSION: NONE PASSED
```

## Decision
**STAGE5_RECALCULATION_REQUIRED**, performed: the time-axis denominator defect is fixed
and versioned (`stage4-run-1.1-timeaxis-fixed`); after recalculation **NONE PASSED
survives** — no strategy is selected. Economics remain **estimated/UNVERIFIED** (mid-only
spread) and the **one-month coverage** is a stated limitation. Stage 6 may proceed only as
an inactive, read-only research dashboard + future observational cohort; **no loss-making
strategy may be described as actionable**. Stop after this audit.
