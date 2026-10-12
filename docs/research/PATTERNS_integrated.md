# M15 structure patterns — integrated design & outcome protocol

Three deterministic, versioned, causal patterns over completed M15 candles, sharing one schema,
the past-only adaptive scale, the 12/24/36/48h price context, other-pair currency-strength
context, supporting/opposing evidence, and a structural invalidation reference. None is a
buy/sell signal; the system stays analytical and manual (no orders, broker, or profitability claim).

| Pattern | Module / version | Starts from | CONFIRMED when | Invalidation reference |
|---|---|---|---|---|
| Accepted balance break | `balanceBreak.js` · `accepted-balance-break-1.0.0` | a balance zone + close-beyond departure | acceptN (2) contiguous closes beyond (or held retest) | breached zone edge (anchored at the provisional close) |
| Failed balance break | `failedBreak.js` · `failed-balance-break-1.0.0` | an attempted departure (built on the accepted break) | 2 contiguous closes reclaimed back inside | a fresh accepted break beyond the edge again |
| Trend pullback continuation | `pullback.js` · `trend-pullback-continuation-1.0.0` | an accepted directional structure (higher-high/lower-low swing pivots) | 2 contiguous closes beyond the prior swing extreme | the prior higher-low / lower-high structural level |

Shared guarantees: confirmation stamped on the candle that first makes it observable (never
backdated — the pullback extreme and the break edge are reported provisional/anchored, not labelled
with later information); every state has an exact knowable candle-close; FORMING / CONFIRMED /
INVALIDATED / UNAVAILABLE with explicit reasons; gaps break contiguity (confirmation withheld, gap
surfaced); the accepted-break and failed-break labels cannot report contradictory current states
(a failure confirms exactly when the accepted break is reclaimed, with a stated transition).

## Workspace presentation (consistent across all three)
Each pattern shows a **named marker at the true confirmation candle and price** — accepted break
(circle), failed break (diamond), pullback (square) — plus a card with status, plain explanation,
the structural invalidation, supporting/opposing evidence and the strength (dis)agreement. A banner
states the patterns are **descriptive structure only — no forecasting display is enabled.**

## Frozen integrated outcome study — `research/m15/patterns_outcome_prereg.js`
Registered before examining outcomes (hashed `SPEC_HASH`). Frozen: the three detector versions, the
forecast horizons **4 and 16** completed M15 candles, the comparison baselines, the deduplication
rules, and the evaluation metrics.

- **Outcome** — directional continuation `sign(close[T+h]−close[T]) === patternDirection` on mid
  closes; UNRESOLVED until `T+h` exists. Excursions in units of the scale.
- **Baselines** — the existing classifier (Established-trend closes), an unconditional baseline
  (every close), and cross-pattern (each pattern vs the other two — e.g. does the failed break add
  beyond the accepted-break transition?).
- **Deduplication** — one instance per `patternId` (the confirmation close; holds are not new
  instances); headline estimate uses a **non-overlapping subsample** (≤1 instance per pair per
  horizon-length window).
- **Evaluation** — chronological (time-ordered) out-of-sample, TRAIN strictly before TEST, nothing
  fit on TEST, with an **embargo of 16 candles (≥ max horizon)** at the split boundary so forecast
  windows cannot leak across the split.
- **Metrics** — sample sizes (n / resolved / pending), directional continuation fraction, **Wilson
  95% interval** (uncertainty), forecast calibration **only if** probabilities are produced,
  **pair** and **session** (Asian/London/NY by EAT) breakdowns, and the delta vs the classifier and
  the unconditional baseline.
- **Reporting** — predictive probability **UNAVAILABLE** until produced and calibrated; trading
  **economics UNAVAILABLE** without realistic spread/execution data; if results are weak, small, or
  inconsistent across pairs/sessions, display **"no reliable forecast"** rather than force a prediction.

## Decision — has any pattern earned a forecasting display?
**No.** No chronological, overlap-controlled, calibrated out-of-sample evaluation has been run (this
environment has no market-data access, and the model remains UNVALIDATED). `decideDisplay()` returns
`NO_RELIABLE_FORECAST`, and the workspace shows the three patterns as **descriptive structure only**,
with no probabilities. A forecasting display may be enabled only after the frozen protocol is run on
unseen data and clears the baselines with calibrated, consistent results.
