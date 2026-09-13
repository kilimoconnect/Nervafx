# Phase 2 — gate diagnosis & justified calibration (M15-only)

Read-only diagnosis + one versioned rule change, run against the frozen Phase 1
baseline on identical time-corrected inputs. No migration, no cron, no deploy, no
push. Analytical / manual only.

## Prerequisites checked
- Phase 1 timing tests pass (`tests/m15/lookahead.test.js` 8/8); replay has **no
  future-candle access**; opportunity counts are **unique episodes** (36), not
  pair-at-close rows (40 armed frames).
- Baseline reproduces: `m15-cfg-1.0.0`, hash **be69b3c4af041e9d** (unchanged after
  all Phase 2 edits — candidate behaviour is flag-gated).
- No unresolved timing defect → calibration against a reliable baseline is valid.

## Step 1–2 — gate diagnosis (denominators: 196,224 evals / directional candidates / 36 episodes / filled)

| Gate | Where | Measurement / threshold | Independent FAIL | Verdict |
|---|---|---|---|---|
| **INSUFFICIENT_SPACE** | pre-strategy hard gate | price→nearest prior leg extreme, `spaceVol ≥ 1.5` | **90.5%** | **Defect (see H-SPACE)** |
| CHAOTIC | market state | `volatilityLevel > 0.45 AND efficiency < 0.35` | 35.2% | No defect established |
| LATE | freshness | `distanceVol ≥ 3.2` (exhausted 4.0) | 44.0% | No defect established |
| NO_AGREEMENT | agreement terminal | mandatory gates + directional grade | 71.0% | Legitimate (separate measures) |

**SPACE — evidence of a real defect** (`scripts/m15/diagnose-gates.js`, full window):
- **48.8%** of `INSUFFICIENT_SPACE` *primary* decisions, and **80.4%** of independent
  space failures, occur on pairs with **no routed candidate** — no direction, entry
  or stop. You cannot have "insufficient trade room" without a trade.
- For routed candidates that space-fail (n=33,971) the barrier is a **minor internal
  swing**: `availableSpaceVol` median **0.146**, p90 0.577, max 1.496 (all < the 1.5
  "sufficient" cap).
- 2026-09-10 15:00 EAT (corrected frame, last candle 11:45 UTC): AUD/CHF & EUR/GBP
  `wouldRoute=false` yet shown INSUFFICIENT_SPACE; EUR/CAD is a real
  FIRST_CONTROLLED_PULLBACK candidate killed by a barrier **0.047 vol** ahead.

**CHAOTIC / LATE.** High percentages alone are not evidence of error (the task says
so). CHAOTIC ⊆ NO_AGREEMENT entirely; its definition (high volatility level + low
efficiency) is genuine two-sided movement, and expansion/pullback states are
measured separately, so no mislabel is demonstrated. LATE ended only 4 episodes;
no evidence it mislabels usable first-controlled-pullbacks. **No change** to either
— the evidence does not support one.

**Conflicting labels — legitimate, not defects.** `power BUILDING` + structure
`EXHAUSTED`: power = capacity to produce efficient/broad/accelerating progress;
structure = aggregate of the member pairs' *states* — a currency can gain power
while its pairs are late. `freshness TRADEABLE` + `NO_AGREEMENT`: freshness =
position-in-move; agreement = multi-evidence vote. Both are the intended "separate
measurements, no single score" design. Phase 3 UI will explain them.

## Step 2 — Hypothesis (written before comparing returns)
**H-SPACE.** The space gate is mis-scoped: it runs *before* a candidate exists and
also blocks the agreement grade, using a trivial nearby swing as the barrier.
**Smallest correction:** space is *N/A* unless a directional candidate with a
defined entry and stop exists; once it does, test **usable room in R** to the
barrier and reject only if `< minRoomR (1.0)`; undefined-risk stays blocked.
**Expected:** the ~half of INSUFFICIENT_SPACE labels with no candidate get their
true reason; thin/undefined setups the baseline armed get blocked. **False-candidate
risk:** relaxing the *agreement* space gate could admit chop into thin room.

## Step 3 — one rule change, split so each half is judged on its own evidence
Flag-gated in `config`; baseline (no flag) is byte-identical. Two variants:
- **`m15-cfg-1.1.0a` — correctness/safety only.** decide-level per-trade space
  (N/A without candidate; room-in-R; undefined-risk→WATCH not ARMED). Agreement
  space gate **kept**.
- **`m15-cfg-1.1.0` — 1.1.0a + agreement space relaxation** (`deferAgreement`), the
  signal-*admitting* half.

Tests added (`tests/m15/space_gate.test.js`, 7): ample room ⇒ ARMED; <1R room ⇒
INSUFFICIENT_SPACE; no-candidate ⇒ relabelled (never space); **undefined-risk stays
blocked**; DEVELOPED expansion doesn't arm; non-space rejections identical across
configs. **Full suite: 117 pass / 0 fail.**

## Step 4 — baseline vs variants (identical inputs, 7,008 closes, 196,224 evals)
Dev = 2026-07-01→08-15, eval = 2026-08-16→09-11 (declared; **previously-inspected
history is NOT an untouched holdout** — Bailey et al.). `docs/phase2/compare_baseline_vs_candidates.json`.

| | Baseline 1.0.0 | **1.1.0a (accept)** | 1.1.0 (reject) |
|---|---|---|---|
| Changed pair-frames | — | 66,357 (33.8%) | 51,428 (26.2%) |
| Unique episodes | 36 | **6** | 66 |
| Episodes added / removed | — | **0 / 30** | 60 / 30 |
| Added-episode outcomes (labelled) | — | none | **38 AMBIGUOUS, 16 STOP, 5 T2**, 1 NO_FILL |
| Top transition | — | INSUFFICIENT_SPACE→CONFLICTED 55,199 | INSUFFICIENT_SPACE→CONFLICTED 24,638 |

- **1.1.0a** is a pure correctness+safety move: it **relabels** the no-candidate
  space rejections to their true reason and **removes 30** baseline episodes that
  had undefined risk or <1R room (e.g. `AUD_NZD BEARISH FCP 2026-07-01 18:00 →
  invalidated:INSUFFICIENT_SPACE`; `CAD_JPY BEARISH EARLY_EXPANSION 2026-07-02
  05:00`). It admits **zero** new setups. Net: fewer, better-defined signals; honest
  labels.
- **1.1.0** additionally admits 60 episodes into thin room (e.g. `CAD_CHF BEARISH
  FCP 2026-07-06 10:30 room 0.339 vol → AMBIGUOUS`; `AUD_JPY BULLISH FCP room 0.489
  → AMBIGUOUS`). 38/60 are AMBIGUOUS (M15 can't order stop vs target) — **chop, not
  opportunity**. Not supported by evidence.

Outcomes are **estimated, mid-price, pre-spread, tiny-n** and are marked ambiguous
where M15 cannot establish stop-vs-target order. **No win rate is claimed.**

## Recommendation
- **ACCEPT `m15-cfg-1.1.0a`** as the published Phase 2 version. It fixes the
  documented, evidence-backed space defect (false "insufficient space" without a
  candidate; undefined-risk armed; thin-room armed) as a correctness/safety change
  with no return-tuning and no new signals — low overfitting risk.
- **REJECT the `deferAgreement` half (`1.1.0`)**; it admits mostly-ambiguous chop.
  Reserve it for **prospective shadow testing** only.
- **Keep baseline `1.0.0` available** as the fallback; the change is flag-gated.
- **Known failure mode of 1.1.0a:** its thin-room block still uses the *nearest*
  prior leg extreme, which is often a minor internal swing, so it can over-block.
  **Barrier-quality** (ignore minor internal swings) is the next single change and
  must be shadow-tested — deliberately not bundled here.
- **Trading performance remains UNPROVEN.** 6 defined-risk episodes over 2.5 months
  is far too sparse to establish an edge; a cleaner gate does not imply profit.

## Files changed / added
- `api/_m15/strategy.js` — per_trade space application + `setupRoomR` + undefined-risk→WATCH (flag-gated; legacy path unchanged).
- `api/_m15/agreement.js` — `space.deferAgreement` flag (default off ⇒ baseline unchanged).
- `api/_m15/config-1_1_0.js` — **new** candidate configs `CONFIG_1_1_0A`, `CONFIG_1_1_0`.
- `tests/m15/space_gate.test.js` — **new** (7 tests). Full suite 117/117.
- `scripts/m15/diagnose-gates.js`, `scripts/m15/compare-configs.js` — **new**, read-only.
- `docs/phase2/compare_baseline_vs_candidates.json` — machine-readable results.
