# PA_W1_H4_MULTI — Weekly market context & four H4 approaches (research)

**Status: UNVALIDATED research.** A ranked candidate is **not** a demonstrated profitable trade.
Stage 5/5A artifacts and the **NONE PASSED** verdict are unchanged. **Price action only** — raw
completed OHLC, confirmed 2-2 fractal swings and close/wick vs references. **No indicators**,
smoothed candles, currency-strength filters, LLM signals or order execution.

The amended **`/weekly-h4`** page answers: *given the completed weekly structure, the relevant
price area, and the observed H4 behaviour, which approach — if any — is eligible now?* It replaces
the previous single-strategy page. The legacy pullback strategy is preserved and clearly labelled
`(legacy)`; its restrictive rules (recent-candle BOS + current-period anchor) apply to **that
approach only**, never to the three new ones. The **Daily → H1** page and the M15 behaviour are
untouched (`/api/paw1h4` default still returns the legacy frame, which the D1→H1 comparison uses).

## Files
- `research/paw1h4/weeklyContext.js` — causal weekly market context (balance + references + location + evidence).
- `research/paw1h4/balanceWalk.js` — H4-vs-band interaction primitive (REJECTION / ACCEPTED / FAILED episodes).
- `research/paw1h4/approaches.js` — the four approach detectors, lifecycle, economics, frame + scan builders.
- `api/paw1h4.js` — `?approaches=1` (multi-approach frame), `?scan=1` (28-pair approach scanner), default = legacy frame.
- `public/paw1h4.html` + `public/paw1h4/approaches-app.js` — the amended page (scanner + selected-pair view).
- `scripts/research/paw1h4-approaches-diagnostics.js` → `docs/research/paw1h4_approaches_diagnostics.json`.
- Tests: `tests/paw1h4/{context,balanceWalk,approaches}.test.js`.

## 1. Weekly context (`w1h4-context-1.0.0`)
From **completed weekly candles only** (knowable at the H4 assessment time; UTC-anchored,
DST-invariant; partial/missing aggregation flagged, never fabricated; the current forming week never
changes the completed assessment):
- **Confirmed swing structure** + trend (BULLISH / BEARISH / NEUTRAL / UNAVAILABLE), reused from `weeklyTrend.js`.
- **Established balance** — boundaries = the most recent confirmed weekly swing **high** (upper) and
  **low** (lower). A balance is *confirmed* only when, over the formation span, weekly closes are
  **contained**, reach **both halves**, and **cross the midpoint ≥ 2×** (oscillation). A one-way pass
  (a trend) is therefore **not** a balance; `NEUTRAL` alone is **not** a balance. Trend and a local
  balance can **coexist** — both are reported and the relationship explained.
- **Structural location** of the latest completed H4 close: `INSIDE / AT_UPPER / AT_LOWER /
  ABOVE_UPPER / BELOW_LOWER` with distances. "Middle of range" is flagged to exclude mid-range setups.
- Supporting / conflicting / **missing** evidence.
- **Buffer** (for invalidation/location) = a raw price-action adaptive scale (`median |Δclose|` over
  the last 24 H4) with a fixed-pip floor — handles zero/flat scale; **not** a smoothed indicator.

## 2. Approach contracts (versioned; thresholds fixed a priori, not tuned on returns)
Shared lifecycle: `CONTEXT_MISSING · NO_SETUP · FORMING · CONFIRMED · OBJECTIVE_UNAVAILABLE ·
INELIGIBLE_ECONOMICS · INVALIDATED`. Next-open entry; gap recheck; cancellation beats trigger in the
same candle; conservative stop-first on ambiguous bars; one opportunity per originating event
(`eventId`); related candidates are **not** independent confirmation. Economics = entry→objective vs
entry→invalidation after modelled costs, with the documented **2:1 research gate** (eligibility, not
profitability). If no objective: economics **UNAVAILABLE**, structural observation retained.

- **Range-boundary rejection** (`range-rejection-1.0.0`) — needs an established balance; a **wick**
  test of a boundary with the close back inside (a wick alone is *not* confirmation), then a completed
  H4 close progressing **away** from the boundary confirms it. Freezes the boundary + rejection
  extreme; invalidation = extreme ± buffer; objective = **frozen balance midpoint** (v1). Excludes
  mid-range. Distinct from a failed breakout (which first closed *beyond* the boundary).
- **Accepted breakout** (`accepted-breakout-1.0.0`) — a weekly boundary **or** confirmed structural
  level known before departure; an **H4 accepted departure** = ≥2 consecutive closes beyond **plus
  progress** (not two closes alone). Labelled "**H4 accepted departure from a weekly reference**",
  never a completed weekly breakout while the week forms. Invalidation = back inside past the
  reference; objective = next confirmed structural level beyond, else economics UNAVAILABLE.
- **Failed breakout** (`failed-breakout-1.0.0`) — an **attempted departure** (≥1 close beyond, not a
  wick) that **reclaims** the range, then a completed H4 close confirms the failure. Freezes the
  failed-departure extreme; invalidation = extreme ± buffer; objective = balance midpoint (v1).
  **Return-into-range** (not a weekly trend reversal). Preserves the chronological transition when an
  accepted breakout later fails (`priorAccepted`).
- **Pullback continuation** (`paw1h4-pullback-1.1.0`, legacy) — the original engine, surfaced as one
  approach, clearly labelled.

## 3. UI (`/weekly-h4`)
- **Scanner** (28 pairs): weekly context (bias + balance), structural location, opportunity type +
  direction, lifecycle stage, economics; grouped by stage then recency — **not** "best trades", no win
  probabilities. Click a pair for its detail.
- **Selected pair**: weekly + H4 charts with named references (balance upper/lower/mid, structural
  levels) and H4 event markers at observable times; market-context card with supporting/conflicting/
  missing evidence; **separate cards for all four approaches** (reference, frozen extreme, structural
  invalidation, objective + reason, modelled economics, "why not further"); ranked-candidates summary.
- UTC + EAT, responsive, causal `?asOf=` replay (verified: appending future candles does not change an
  as-of frame).

## 4. Diagnostics (current snapshot, 28 pairs; EXPLORATORY)
`node scripts/research/paw1h4-approaches-diagnostics.js` → `paw1h4_approaches_diagnostics.json`.
Latest-close snapshot candidate counts by approach × state, confirmed list, and a first-rejection
funnel. In the inspected snapshot: **7 CONFIRMED** candidates across pairs (e.g. EUR_JPY accepted
breakout R:R 13.1, NZD_USD range rejection R:R 4.9, USD_CAD failed breakout R:R 2.1). The dominant
rejection reason is **"no established weekly balance"** (52) — most pairs are not in a confirmed
balance, as intended. **This is exploratory, not a result** — a full historical, out-of-sample
economic evaluation of the new approaches is required before any claim; no profitability is implied.

## 5. Tests
`node --test tests/paw1h4/*.test.js` — **51/51** (context: balance vs trend, causality; balanceWalk:
rejection / accepted / failed / accepted-then-failed; approaches: valid rejection → CONFIRMED,
mid-range exclusion, accepted-departure labelling + objective, failed-breakout vs plain wick, frame
causality). Daily → H1 **4/4** and M15 research **157/157** unchanged (no regression).

## 6. Data inspected & limitations
- Inspected: stored **H1** for the 28 majors (~2024-H2 → 2026-10, ~17 months), aggregated to W1/H4.
- Limitations: short history → weekly balances and new-approach samples are small (exploratory). The
  balance definition is swing-boundary based (v1); opposite-boundary targets and multi-balance nesting
  are registered variants/future work. Economics are **mid-only estimated**; the 2:1 gate is a research
  eligibility rule only. No migrations/deploy/push were performed (local only, per the task).
