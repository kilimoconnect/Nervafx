# Stage E — classifier-state information-content study (pre-registered)

Tests whether M15 classifier states carry useful **future information**. It does **not**
create a strategy, **never** labels historical fit as proof, and **does not overturn** the
immutable Stage 5 / 5A **NONE PASSED** decision. A gate pass yields at most
`ELIGIBLE_FOR_NEW_SHADOW_REVIEW` (owner review for a FUTURE prospective shadow cohort).

## Pre-registration FROZEN before any outcome (audit-critical)
The hypotheses and full config were written and hashed **before** any outcome table was
computed or viewed:
- `research/m15/infocontent_prereg.js` → `docs/research/infocontent/PREREGISTRATION.json`
- **registrationHash `c5a26dd1582726d5267694e75397c9dea28c1d36f2df5265cf1698408e4dd6b6`**
  (`docs/research/infocontent/PREREGISTRATION.hash.json`).

**Hypotheses:** H1 accepted trends have more same-direction net forward movement than
matched opportunities; H2 rejected departures continue less than accepted departures;
H3 independent currency breadth adds information beyond the price-only state.

**Config (frozen):** 28 eligible pairs; episode = first transition into a state family,
one open episode per pair (dedup key pair/family/dir/firstClose); entry at the **next
candle open** (never same-bar); outcomes in **ATR14 risk units** at horizons **4/8/16**;
pair **and** network timestamps kept together; **5-fold chronological nested walk-forward**
with state calibration fit on inner-train only and **no post-result threshold changes**;
**96-candle embargo**; dependence-aware **ISO-week-block bootstrap** (seed 20261007, 2000
resamples, 95% CI); **Holm-Bonferroni** across the 3 hypotheses; matched controls =
**price-only** (network omitted) + **matched null** (seeded) + matched opportunity;
costs **ESTIMATED** (mid-only data; tradability not asserted) with delay {0,1}; gates:
INSUFFICIENT (<200 episodes / <8 weeks / partial coverage / synthetic-or-exploratory),
REJECT (Holm-adjusted CI ≤ 0), ELIGIBLE (CI>0 Holm-adjusted, OOS all folds, beats both
controls, ≥60% positive weeks, no pair/currency >50%, ≥200 episodes, economics ESTIMATED).

## Data reality in this environment (drives the verdict)
- `backtest_candles` is **mid-only** — **no bid/ask**. Economics are therefore **ESTIMATED**
  and tradability **cannot** be asserted (registered rule).
- **No real held-out dataset is loaded** here (no DB credentials in the session). Prior
  real history is **EXPLORATORY** by the registration. The run therefore uses **synthetic**
  fixtures and is labelled `SYNTHETIC_EXPLORATORY`.
- By the registered INSUFFICIENT gate, synthetic/exploratory provenance **cannot** be
  eligible, independent of any numbers observed.

## Result — every registered hypothesis: **INSUFFICIENT_EVIDENCE**
`node scripts/research/infocontent-run.js` (`docs/research/infocontent/report.json`):

| Hypothesis | Episodes | Week-blocks | Verdict | Reason |
|---|---|---|---|---|
| H1 accepted > matched | 2 | 1 | **INSUFFICIENT_EVIDENCE** | synthetic/exploratory; far below 200 episodes / 8 weeks |
| H2 rejected < accepted continuation | 0 | 0 | **INSUFFICIENT_EVIDENCE** | synthetic/exploratory; no paired weeks |
| H3 breadth adds info | 2 | 1 | **INSUFFICIENT_EVIDENCE** | synthetic/exploratory |

**Stage 5 / 5A NONE PASSED is preserved and unchanged.** `registrationHash c5a26dd1…`,
`dataHash d58aabcd3e2a0792`, provenance `SYNTHETIC_EXPLORATORY`, economics `ESTIMATED`.
Full trial list retained in `report.json` (`trials[]`).

## The gate machinery is proven correct (so real data would be judged faithfully)
`node --test tests/research/infocontent.test.js` → **10 pass / 0 fail**, including:
- ELIGIBLE **only** when all registered conditions hold on `REAL_HOLDOUT`;
- **REJECT** when the CI is entirely ≤ 0;
- **INSUFFICIENT** on too-few episodes, too-few weeks, or Holm failure;
- **synthetic/exploratory can never be eligible even with perfect stats**;
- Holm rejects in order and stops at first failure;
- outcome enters at the next open (never same-bar) and cost reduces R;
- week-block bootstrap is seeded/deterministic;
- `evaluate` preserves NONE PASSED and never eligible on synthetic.

## Files
`research/m15/infocontent_prereg.js` (frozen), `research/m15/infocontent.js` (harness),
`scripts/research/infocontent-run.js` (driver), `tests/research/infocontent.test.js`,
`docs/research/infocontent/{PREREGISTRATION.json, PREREGISTRATION.hash.json, report.json, report.summary.json}`.

## How to reproduce
```bash
node scripts/research/infocontent-run.js      # writes report + summary; prints verdicts
node --test tests/research/infocontent.test.js
```

## To obtain evidential results later (not done here)
Run the SAME frozen registration on **real held-out** `backtest_candles` across the full
period with **actual bid/ask** (currently unavailable) so provenance = `REAL_HOLDOUT` and
economics can be `CONFIRMED`. Only then can a hypothesis reach
`ELIGIBLE_FOR_NEW_SHADOW_REVIEW` — which still only permits **owner review** for a future
prospective shadow cohort and is **never** proof of live profitability.

## Limitations
- Synthetic fixtures, mid-only ⇒ ESTIMATED economics; not a holdout; not tradable evidence.
- Inner-fold calibration is a documented hook (keeps registered defaults in v1); no
  post-result tuning is permitted.
- No live signals, scheduler, broker, deployment, or push (per instruction). Stopped here.
