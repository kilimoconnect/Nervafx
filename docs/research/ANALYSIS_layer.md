# M15 Analysis layer — definitions & assumptions (`m15-analysis-1.0.0`)

Additive, explicitly versioned description that composes EXISTING causal features. It does **not**
change the three patterns, the classifier, or any frozen study/verdict; it is emitted as a parallel
`analysis` field per frame. Completed M15 OHLC only; past-only adaptive scale; no smoothed candles,
indicators, extra timeframes, new patterns, signals or probabilities. Reuses `priceaction.describeWindow`
(block metrics), the swing/balance events, and `strengthnet.estimateWindow` (per-block strength).

## 1. Recent vs earlier — four consecutive non-overlapping 12h blocks
- Blocks: **0–12h, 12–24h, 24–36h, 36–48h**, by **elapsed time** (boundaries `T−12h … T−48h`), each
  with **nominal 48 candles**. Membership: candle **close** ∈ `(fromMs, toMs]`.
- Each block's displacement, travel, directional efficiency, range, overlap, position are computed
  **directly from that block's candles** via `describeWindow` — never by subtracting overlapping windows.
- **Coverage is explicit:** `actualCandles`, `coveragePct` (vs nominal 48), and `expectedOpenCandles`
  / `openCoveragePct` (vs M15 slots not in the closed-market window Fri 21:00–Sun 21:00 UTC). Missing
  candles and closures stay visible. Elapsed hours are distinguished from a fixed candle count.
- **`recentVsEarlier.verdict`** compares the latest block to the earlier structure holistically (net
  earlier displacement + average |efficiency|), not as independent votes:
  `continues / strengthens / weakens / conflicts / unclear` (margin `effMargin = 0.15`).
- The overlapping 12/24/36/48h views are **retained** elsewhere (price-story matrix).

## 2. Quality of price progress
Composed from existing measurements (no order-flow/volume inference):
`sustained_progress` (|eff| ≥ 0.50), `congestion` (overlap ≥ 0.70 & |eff| < 0.25), `back_and_forth`
(|eff| < 0.25), else `mixed`; plus "repeated attempts" from the balance departure/return counts, and a
pullback-preserves/damages note from the last confirmed swing (reused, not a new pattern). Thresholds
`0.70 / 0.25` reuse the existing `priceaction.classifyState` BALANCED cut; `0.50` is a descriptive
"half the travel was net progress". **All thresholds are past-only, versioned (`analysis-thresh-v1`),
and not tuned to outcomes.**

## 3. Structural location
Current close vs already-known references: balance boundaries, last confirmed swing high/low,
and 48h **lookback extrema** — the first two flagged `confirmed:true`, the extrema `confirmed:false`.
Each carries distance in **price units** and, where scale > 0, **adaptive-scale units**; `knownSinceMs`
records when it became knowable (a pivot: its **confirmation** time, not its extreme). Zero/unavailable
scale → scale-unit distance `null`. Proximity is descriptive, never a guaranteed turning point.

## 4. Pace & deterioration
`perBlock` net progress per 12h; `sinceEvent` describes behavior since the last confirmed swing
(timestamp + elapsed hours, **confirmation delay** noted; measured from the candle after it became
knowable) with net progress vs total travel vs efficiency. `deterioration.weakening` flags
"travelled more but advanced less" between the last two 12h blocks — described as weakening progress /
congestion, **not** a guaranteed reversal. No arbitrary candle-count confirmations.

## 5. Currency-support breadth & change
Retains the pair's **leave-one-pair-out** estimate. Separates **base** and **quote** behavior
(`strengthByBlock`, `trend`, `breadthFraction`, `breadthTrend`), the contribution to pair direction
(`gap = strength(base) − strength(quote)`, `gapMin = 0.0003`), and change across the four blocks:
magnitude → `strengthening / fading / steady`; breadth → `broadening / narrowing / steady`.
`bothCurrenciesActive` + `netDirectionUnclear` surface a strong-base-and-strong-quote / muted-pair case
(two-way activity, not directional strength). Correlated pairs are not treated as independent.
Per-block strength = `estimateWindow` of the 12h window ending at each boundary (requires a connected
network; otherwise that block is unavailable and stays visible as such).

## 6. Deterministic template summary
Seven fields, each tracing to explicit evidence: broader structure direction, recent change, progress
quality, structural location, currency support, **strongest plausible alternative**, and the observed
condition / structural reference that would change the assessment. Uses "unclear"/"unavailable" when
evidence is insufficient; no invented confidence scores. The invalidation condition is stated as an
**interpretation invalidation, explicitly not a trade stop.**

## Reproducibility audit
`reproduce` pins: `inputDigest` over **all OHLC fields** of the pair; `otherPairInputsDigest`
(+`otherPairInputsCovered`) over the all-pair latest closes when histories are available; `configDigest`
over the thresholds; and versions (analysis / priceaction / thresholds).
**Honest limitation:** other-pair inputs are **hashed, not snapshotted**; when per-block strength is
passed in pre-computed, the digest does not cover the all-pair histories — a full audit needs them.

## Workspace integration
Market review gains a concise **Assessment** card (the summary + strongest alternative + what would
change the read), an **expandable four-block comparison**, and a **currency-support breakdown**; detailed
metrics stay in the expandable/evidence areas so the main screen is not crowded. All views, historical
selection and replay use the **same causal `analysis` contract** (immutable as of close). Every displayed
interpretation records its version (`m15-analysis-1.0.0`).

## Future evaluation (separate; frozen studies preserved)
These are **descriptions, not forecasts** — no improved forecasting is claimed. A future study (kept
separate from the existing frozen pattern studies) should compare the classifier **baseline** against
these analysis descriptions on **later, unseen** M15 data, chronologically and overlap-controlled, before
any forecasting display is considered. The existing `*_outcome_prereg.js` specs remain unchanged.
