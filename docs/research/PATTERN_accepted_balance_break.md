# Pattern contract — Accepted balance break (up / down)

Module: `research/m15/balanceBreak.js` · version `accepted-balance-break-1.0.0`
Deterministic, completed M15 candles only. **Reuses** the causal balance-zone + departure
lifecycle in `priceaction.balanceLifecycle` — it does not build a second structure engine.
It only interprets those events, for the most-recent departure episode, into one pattern
instance. The model remains **UNVALIDATED**; this pattern is descriptive, never a buy/sell signal.

## 1. Balance area and departure (existing research definitions)
- **Scale (past-only, adaptive):** `tol = zoneTolK(1.0) × median|Δclose|` over the 48h window.
  No EMA/RSI, no candlestick names, no fixed-pip rules.
- **Balance area:** the most-interacted close band `[center − tol, center + tol]`, where `center`
  is the close with the most neighbours within `tol`. It only exists once **≥ minTouches (3)**
  closes have fallen inside it (`BALANCE_FORMED`).
- **Departure:** the first completed close beyond the band (`DEPARTURE_PROVISIONAL`). Direction is
  UP if that close > zone high, DOWN if < zone low.

## 2. What confirms acceptance of the departure
A departure is accepted (`DEPARTURE_ACCEPTED`) when **either**:
- **acceptN (2) CONTIGUOUS completed closes beyond** the band (kind = `consecutive`); or
- a **held retest**: price closes back toward the breached edge (within `tol` of it — a `TEST`,
  not a full return), then closes beyond the band again (kind = `retest`).
Acceptance is the pattern's **CONFIRMED** trigger. **Contiguity is required** (ambiguity #2): a data
gap at the confirming candle withholds confirmation — the pattern stays **FORMING** with
`confirmationPending: "DATA_GAP"` until contiguous closes beyond occur (a later contiguous hold does
confirm, stamped on the real candle).

## 3. FORMING vs CONFIRMED vs INVALIDATED vs UNAVAILABLE
- **FORMING** — a provisional departure exists; not yet accepted and not returned.
- **CONFIRMED** — the departure was accepted (consecutive or held-retest) and price has not since
  closed back inside the zone.
- **INVALIDATED** — either (a) a provisional break closed back **inside** the zone (deeper than
  `tol` from the breached edge) before acceptance (`RETURN`), or (b) a CONFIRMED break later had a
  completed close back inside the zone (the structural reference was reclaimed).
- **UNAVAILABLE** — cannot evaluate: `NO_DATA`, `INSUFFICIENT_DATA`, `NO_ZONE` (flat / no band), or
  `NO_ACTIVE_BREAK` (a valid zone with no departure in progress).

## 4. Exact candle-close at which each state becomes knowable (`knowableAtMs`)
- **FORMING** — the close of the first candle beyond the zone (the `DEPARTURE_PROVISIONAL` close).
- **CONFIRMED** — the close of the candle that completes acceptance (the 2nd consecutive beyond-close,
  or the re-break close after a held retest) = `confirmation.ms`. Never earlier.
- **INVALIDATED** — the close of the candle that returns inside the zone (pre-acceptance `RETURN`,
  or the post-confirmation re-entry close).
- **UNAVAILABLE** — the evaluation close `T`.
Replay tests assert no state or timestamp appears before its causal candle.

## 5. Structural invalidation reference
The **breached edge** — `zone.high` (UP) / `zone.low` (DOWN) — **anchored to the zone as of the
provisional close** so the level does not drift as the adaptive 48h zone is recomputed (ambiguity #3).
Rule: a CONFIRMED break is invalidated by **acceptN (2) consecutive completed closes back inside the
zone** (symmetric with acceptance — a single reclaim close is noise, ambiguity #1); a FORMING break is
invalidated by a pre-acceptance `RETURN`. `invalidation.hitMs` is set once it occurs.

## Resolved design decisions (the seven ambiguities)
1. **Post-confirmation invalidation** needs **2 consecutive closes back inside** (not one).
2. **Acceptance must be contiguous** — no gap at the confirming candle (see §2).
3. **Invalidation edge anchored** at the provisional close (see §5).
4. **"Confirmation delay"** = the acceptance lag itself (held-retest / contiguous hold), consistent with
   the causal swing-pivot philosophy. Confirmed swing pivots are **not** required; `swingContext`
   reports the last confirmed pivot and whether it supports the break (descriptive only).
5. **Strength agreement** = `sign(baseMinusQuote)` vs break direction (UP agrees when gap > 0).
6. **History** — `recentEpisodes` lists up to 3 prior resolved episodes (direction + CONFIRMED/INVALIDATED).
7. **Outcome study** — horizons are **candles** (4 = 1h, 16 = 4h); groups = pattern vs classifier
   "Established trend" closes vs unconditional baseline; walk-forward on unseen periods, ISO-week blocked.

## Separate evidence fields (strength disagreement stays visible)
- `priceContext` — 12/24/36/48h efficiency, direction, range, position-in-range (separate field).
- `strength` — other-pair currency-strength gap for the pair, its direction, `agrees` vs the break,
  and a `disagreement` string when it opposes the break (surfaced, never discarded).
- **Deduplication:** one episode per call; `patternId = pair@provisionalMs` is stable across replay,
  so overlapping re-detections and repeated `CONTINUATION` holds map to a single confirmation.

## UI
A named marker is drawn at the confirmation candle and price (`Accepted break (up/down)`), with a
dashed **invalidation reference line** at the breached edge, plus a card stating what confirmed it and
what would invalidate it. No buy/sell arrow. UNVALIDATED status preserved.

## Frozen outcome study (separate) — `research/m15/balanceBreak_outcome_prereg.js`
- Unit: one CONFIRMED instance (deduped), clock starts at its confirmation close.
- Horizons: **4 and 16** completed M15 candles.
- Outcome: continuation = `sign(close[T+h] − close[T]) === breakDirection`, on **mid** closes; plus
  max favourable / adverse excursion in units of `tol`.
- Groups: **pattern** vs the existing **classifier** Established-trend states vs an **unconditional baseline**.
- Protocol: walk-forward on **later, unseen** periods; detector + thresholds frozen; ISO-week blocking.
- Reporting: counts and raw continuation fractions only. **Predictive probability = UNAVAILABLE** until
  evaluated on unseen data and calibrated. **Economics = UNAVAILABLE** (mid-only; no bid/ask). Spec is
  hashed (`SPEC_HASH`) and registered before evaluation.
