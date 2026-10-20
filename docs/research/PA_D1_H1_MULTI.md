# PA_D1_H1_MULTI — Daily market context & four H1 approaches (research)

**Status: UNVALIDATED research.** A ranked candidate is **not** a demonstrated profitable trade.
Stage 5/5A artifacts and the **NONE PASSED** verdict are unchanged. **Price action only** — raw
completed OHLC, confirmed 2-2 fractal swings, close/wick vs references. **No indicators**, smoothed
candles, currency-strength filters, LLM signals or order execution. Manual decisions only.

The replacement **`/daily-h1`** page answers: *given the completed daily structure, the relevant
price area, and the observed H1 behaviour, which opportunity — if any — is eligible now?* It supports
four approaches: **pullback continuation**, **range-boundary rejection**, **accepted breakout**,
**failed breakout**. This is the Daily→H1 analogue of [PA_W1_H4_MULTI](PA_W1_H4_MULTI.md) and **reuses
the same verified engine** through a timeframe descriptor — only the trend/entry aggregators and the
display names differ (D1/H1 vs W1/H4).

## What was replaced / preserved
- **Replaced:** the active Daily→H1 engine output, API default and page. `/api/pad1h1` now returns the
  **multi-approach** frame by default; `/daily-h1` is the new context+approaches workspace.
- **Archived (preserved, reproducible):** the original pullback-only engine `PA_D1_H1_CONTINUATION`
  (`research/pad1h1/*`, `research/paw1h4/pipeline.js` `TF_D1H1`) is intact and served at
  **`/api/pad1h1?legacy=1`**; its backtest `docs/research/pad1h1_backtest.json` is unchanged. The
  pullback approach on the new page uses that same legacy engine (clearly labelled `(legacy)`), so its
  restrictive rules apply to **that approach only**.
- **Untouched:** Weekly→H4 and M15 (no shared-code regressions; see tests).

## Shared core (timeframe-parameterized)
`research/paw1h4/{weeklyContext,balanceWalk,approaches}.js` now take a timeframe descriptor
(`MTF_W1H4` / `MTF_D1H1`). For D1→H1: **trend = D1** (UTC-day aggregate of H1, DST-invariant,
00:00→00:00 UTC), **entry = H1** (used directly). Everything else — the balance definition
(oscillation test; a one-way trend is not a balance; `NEUTRAL` alone is not a range; trend+balance
can coexist), structural location, the four versioned contracts, lifecycle, next-open economics with
the documented **2:1 research gate**, dedup by originating event — is identical and already tested.
Reason strings and labels are timeframe-aware ("daily balance", "H1 accepted departure from a daily
reference", …). The adaptive **buffer** is a raw `median |Δclose|` over the last 24 H1 with a pip
floor (handles zero/flat scale) — **not** an indicator.

## Approach contracts
Same versioned contracts as the W1→H4 doc §2 (`range-rejection-1.0.0`, `accepted-breakout-1.0.0`,
`failed-breakout-1.0.0`, legacy `paw1h4-pullback-1.1.0`), read on the **daily** trend / **H1** entry:
eligibility, formation, confirmation (a wick alone is insufficient; progress-away / acceptance /
reclaim-confirmation defined), next-open entry with gap recheck, frozen references, structural
invalidation (extreme ± buffer), objective (balance midpoint v1 for rejection/failed; next structural
level for accepted, else economics UNAVAILABLE), expiry, cancellation (beats trigger in-candle),
conservative stop-first. A forming daily candle never establishes a completed daily trend/pivot/
breakout; H1 may *interact* with a known daily reference. Setups cross midnight and persist until a
declared structural invalidation / context change / expiry.

## UI (`/daily-h1`)
Responsive workspace, shared label-driven renderer (`public/paw1h4/approaches-app.js`): **28-pair
scanner** (daily context, structural location, approach+direction, lifecycle stage, economic
eligibility/reason, freshness) and **selected-pair view** (D1 + H1 charts with named references and H1
event markers at observable times, context + supporting/conflicting/missing evidence, **separate
cards for all four approaches** with reference/invalidation/objective/economics/"why not further",
ranked-candidates summary). UTC + EAT, causal `?asOf=` replay (verified: appending future candles does
not change an as-of frame; identical live/historical calculations). Sorting is transparent by
stage then recency — **not** "best trades", no win probabilities, related candidates are not
independent confirmation.

## Diagnostics (current snapshot, 28 pairs; EXPLORATORY)
`node scripts/research/pad1h1-approaches-diagnostics.js` → `pad1h1_approaches_diagnostics.json`.
Candidate counts by approach × state, confirmed list, first-rejection funnel. In the inspected
snapshot: **7 CONFIRMED** (all accepted breakouts, e.g. EUR_CAD R:R 20.9, NZD_USD R:R 18.5, CAD_JPY
R:R 15.4). Dominant rejection reason: **"no established daily balance"** (72) and "no H1 accepted
departure…" (45). **Exploratory, not a result** — a full out-of-sample economic evaluation is required.

## Tests
`node --test tests/pad1h1/*.test.js` — **6/6** (incl. D1→H1 multi balance + all-four-approaches +
frame causality + archived-legacy pullback wiring). `tests/paw1h4/*.test.js` — **51/51** (W1→H4 multi
unchanged after parameterization). M15 research **157/157**. No regressions.

## Data inspected & limitations
Stored **H1** for the 28 majors (~2024-H2 → 2026-10), aggregated to D1. Daily balances form more
often than weekly, but samples for the new approaches are still small — exploratory. Balance detection
is swing-boundary based (v1); opposite-boundary targets and multi-balance nesting are registered
future variants. Economics are **mid-only estimated**; the 2:1 gate is a research eligibility rule, not
an edge. No migrations/deploy/push were performed (local only, per the task).
