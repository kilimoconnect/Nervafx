# M15 Strategy Research — Stage 5 handoff (time-respecting comparison)

Reproducible walk-forward comparison of the frozen Stage 3 candidates on the Stage 4
outcomes. Rules and fold logic were fixed **before** computing comparisons. Read-only;
production untouched. **No candidate is called PROVEN PROFITABLE; "none passed" is a
valid result.** The old production-engine 10-fill report is kept entirely separate.

- Framework: `research/m15/walkforward.js` (pure). Runner: `scripts/research/stage5-compare.js`.
- Inputs: `docs/research/stage4_episodes.json` (per-episode records). Output: `docs/research/stage5_scorecard.json`.
- Tests: `node --test tests/research/*.test.js` → **44 pass / 0 fail** (loader 9, features 10, registry 9, outcomes 8, walk-forward 8).

## Exact commands (reproducible)
```bash
node scripts/research/backtest-run.js  --from 2026-07-01 --to 2026-09-25   # produce per-episode records
node scripts/research/stage5-compare.js                                    # walk-forward scorecard
```

## Method (time-respecting, dependence-aware)
- **Split:** each candidate's episodes are split by DATE into a CALIBRATION (earlier
  50%) and EVALUATION (later 50%) with a **1-hour embargo** across the boundary so no
  trade/target overlaps a fold edge. All 28 pairs at one timestamp fall in the same
  fold (folds are by date).
- **Variant selection on prior only:** where a family has multiple variants, the
  variant is chosen by best **calibration** mean net R; the reported number is the
  **evaluation (OOS)** result — never the reverse.
- **Uncertainty preserves dependence:** a **block (week) bootstrap** CI on mean net R —
  resampling whole weeks, so within-week and shared-currency dependence is kept (no
  naive independent-candle SE).
- **Stability & concentration:** per-week fold means (positive-fold share) and the max
  share of episodes touching any one currency.
- **Costs/timing stress:** economics at spread 0 / 1.2 / 2.4 pips and a one-more-candle
  manual delay (from Stage 4). All ESTIMATED (mid-only data).

## Coverage & the "not a pristine test" caveat
Reported window: **2026-08-25 → 2026-09-25** (one month; 3,056 closes, 85,568
pair-at-close evals, 67,361 episode records). A larger window is available via the
full-range command (its qualitative result is unchanged — see the 7-day and 1-month
slices, both uniformly negative). Per the
Stage instruction, **July–11 Sep 2026 was examined in prior NervaFX work and is NOT a
pristine untouched final test**, and history inspected while designing rules is not an
untouched test either. **Genuine confirmation therefore requires a later, post-freeze
SHADOW period** — which is the recommendation regardless of these in-sample-adjacent
numbers. The full verified range command (`--from 2025-05-19`) is provided for a
longer offline confirmation.

## Decision standard (documented, applied by `decide`)
A candidate is **SELECT_FOR_SHADOW** only if ALL hold on the OOS split:
positive net economics (bootstrap **CI low > 0**), a gain over the simpler baseline,
beats the pseudo-random control, fold-stable (**≥60%** positive weeks), not
one-currency-dependent (**≤50%** concentration), and **≥30** OOS episodes. A whole CI
below 0 ⇒ **REJECT**. Otherwise ⇒ **INSUFFICIENT_EVIDENCE**. Never invent a target win
rate or optimize for signal count; prefer the simpler variant when additions do not
materially improve evidence.

## Results — **NONE PASSED**
`docs/research/stage5_scorecard.json`. Out-of-sample (later split), net R at typical
(1.2 pip) spread, block(week)-bootstrap 95% CI:

| Candidate | OOS episodes | OOS mean net R | 95% CI | positive weeks | Verdict |
|---|---|---|---|---|---|
| A0 baseline (dir10) | 20,575 | −0.319 | [−0.355, −0.289] | 0% | **REJECT** |
| A1 +consistency | 7,709 | −0.262 | [−0.333, −0.246] | 0% | **REJECT** |
| A2 +breadth | 7,569 | −0.250 | [−0.333, −0.223] | 0% | **REJECT** |
| A3 +structure/energy | 298 | −0.515 | [−0.633, −0.310] | 0% | **REJECT** |
| B continuation | 6,137 | −0.270 | [−0.406, −0.218] | 0% | **REJECT** |
| C early expansion | 2,220 | −0.293 | [−0.385, −0.250] | 0% | **REJECT** |
| D first pullback | 3,285 | −0.359 | [−0.421, −0.249] | 0% | **REJECT** |
| E compression release | 0 | — | — | — | INSUFFICIENT |
| F failed extension | 0 | — | — | — | INSUFFICIENT |
| CTRL pseudo-random | 19,568 | −0.289 | [−0.314, −0.264] | 0% | **REJECT** |
| NULL no-signal | 0 | — | — | — | INSUFFICIENT |

Baseline (A0) OOS −0.319; control OOS −0.289. **Every candidate's CI is entirely below
zero and no week is positive.** Direction accuracy over the window was ~0.46–0.50
(near/below coin-flip). E/F never triggered even over a month (rare states).

**Incremental A-ladder** (selected variants; episodes added/removed, mean net R):
A0→A1 removes 11,890 / adds 3,781 (−0.327 → −0.306); A1→A2 removes 3,089 / adds 1,633
(−0.306 → −0.319); A2→A3 removes 3,711 / adds 219 (−0.319 → −0.266). Each gate
**reduces activity without producing positive economics** — no addition materially
improves the evidence, so the simpler variant is preferred, and none is selectable.

## Conclusion — none passed; recommended next observation
No candidate meets the standard: none shows positive out-of-sample net economics, none
beats break-even, and none beats (or even clearly separates from) the pseudo-random
control — over a window that is itself not an untouched test. **Verdict: NONE PASSED —
INSUFFICIENT EVIDENCE for any strategy; no PROVEN PROFITABLE claim is made.**
**Recommended next observation:** activate the (verified) snapshot scheduler and accrue
a **post-freeze, forward shadow cohort** on these frozen rules before any further
evaluation; do not re-select rules on this same history.

## Limitations
- Mid-only data ⇒ all economics ESTIMATED; spread/slippage modelled, not measured.
- The window overlaps previously-examined history ⇒ not an untouched test; a
  post-freeze shadow period is required for genuine confirmation.
- Enumerated 15-variant trial budget ⇒ multiple-comparison risk; the decision standard
  requires beating baseline AND control AND fold stability to mitigate it.
- Replay-vs-stored-snapshot parity remains UNTESTED (no snapshots recorded yet).

## Stop after Stage 5
Deliver exactly one frozen shadow candidate only if the scorecard yields a single
SELECT_FOR_SHADOW; otherwise deliver **NONE PASSED** and the recommended next
observation (activate the snapshot scheduler and accrue a post-freeze shadow cohort).
