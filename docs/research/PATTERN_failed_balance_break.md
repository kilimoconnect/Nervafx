# Pattern contract — Failed balance break (up / down attempt)

Module: `research/m15/failedBreak.js` · version `failed-balance-break-1.0.0`
Built **on top of** `balanceBreak.detect` (accepted-break, `accepted-balance-break-1.0.0`) so the two
patterns share one zone/episode/anchored edge and can never report contradictory current states.
Completed M15 candles only; past-only adaptive scale (the zone `tol`); no EMA/RSI/candlestick-names/pips.
A failed break is a **loss of the breakout — not a reversal or opposite-trade signal.**

## Causal definition
1. **Balance area + attempted departure** — identical to the accepted-break contract: zone
   `[center ± tol]`, `tol = 1.0 × median|Δclose|` over 48h, formed after ≥3 inside closes; the attempt
   is the first completed **close** beyond the zone (`DEPARTURE_PROVISIONAL`). A **wick-only**
   penetration (high/low beyond, close inside) is a `REJECTION`, **not** an attempt ⇒ no failed break.
2. **Re-entry + meaningful-failure evidence** — the departure is reclaimed when price closes back
   **inside** the zone. To separate a *meaningful failure* from a *routine retest*, the re-entry must be
   **accepted**: **acceptN (2) CONTIGUOUS completed closes inside** the zone (after the departure, or
   after its acceptance). A single re-entry close is a retest ⇒ FORMING only.
3. **States** — see the table below.
4. **If an ACCEPTED break subsequently fails** — when a *confirmed accepted break* is later reclaimed
   (2 contiguous closes back inside), the failed break CONFIRMS with `failureType = "acceptance-reclaimed"`
   and a `transition { from: "ACCEPTED_BREAK_CONFIRMED", to: "FAILED_BREAK" }`. At that same close the
   accepted-break reads `INVALIDATED` (same threshold) — consistent, and the transition is stated.
5. **Confirmation timestamp + invalidation reference** — confirmation is stamped on the **reclaim
   candle** (the 2nd contiguous inside close), **never backdated** to the first candle outside the area.
   The invalidation reference is the **anchored breached edge** (from the accepted-break, fixed at the
   provisional close); the failed break is invalidated by a **fresh accepted break beyond that edge
   again** (2 contiguous closes beyond).

## State-transition table (as of close `T`, for the current episode)
| Condition at `T` | State | Knowable at |
|---|---|---|
| No zone / no data / insufficient candles | UNAVAILABLE (`NO_ZONE` / `NO_DATA` / `INSUFFICIENT_DATA`) | `T` |
| Zone exists but no close-beyond attempt (wick-only or none) | UNAVAILABLE (`NO_ATTEMPT`) | `T` |
| Attempt beyond, still holding beyond (no re-entry) | UNAVAILABLE (`NO_FAILURE` if it was accepted, else `NO_FAILURE_YET`) | `T` |
| Re-entered the zone, **1** inside close (or retest) so far | **FORMING** | first re-entry close |
| **2 contiguous** inside closes after an un-accepted departure | **CONFIRMED** (`failureType: departure-rejected`) | reclaim close |
| **2 contiguous** inside closes after an accepted break | **CONFIRMED** (`failureType: acceptance-reclaimed`, + transition) | reclaim close |
| After the failure, a **fresh accepted break** beyond the edge (2 contiguous beyond) | **INVALIDATED** | re-break close |
| Reclaim would span a **data gap** (non-contiguous) | **FORMING** (`confirmationPending: "DATA_GAP"`) | first re-entry close |

## Reused schema / evidence (separate fields)
`priceContext` (12/24/36/48h), `strength` (other-pair currency strength for the **original attempt**
direction — disagreement preserved), `swingContext`, `zone`, `attempt {provisionalMs, wasAccepted,
acceptedMs}`, `transition`, `dataHealth {gaps, staleBeforeClose}`, `patternId = pair@failed@provisionalMs`.

## Non-contradiction with the accepted break
A failed break CONFIRMS at the exact close the accepted break is reclaimed (same acceptN threshold), so
they are never both "succeeding": `accepted CONFIRMED` and `failed CONFIRMED` cannot co-occur. When they
flip, the `transition` field explains it.

## UI
A labelled **diamond** marker is drawn at the reclaim (confirmation) candle and price — `Failed break
(up/down attempt)` — distinct from the accepted-break marker; the card explains the attempted break and
why it failed, plus the transition. No buy/sell arrow; UNVALIDATED preserved.

## Frozen outcome study — `research/m15/failedBreak_outcome_prereg.js`
Horizons **4 and 16** completed M15 candles. Outcome measured **descriptively** in the original attempt
direction (no reversal claim). Compares **failed** vs the **classifier**, the **accepted-break transition
alone**, and an **unconditional baseline**. Time-ordered walk-forward on unseen periods; overlapping
forward windows handled by ISO-week blocking + a non-overlapping subsample. Predictive probability and
any "improvement" claim are **UNAVAILABLE** until calibrated on unseen data; profitability is
**UNAVAILABLE** without bid/ask. Spec hashed (`SPEC_HASH`). No entry/exit instructions.
