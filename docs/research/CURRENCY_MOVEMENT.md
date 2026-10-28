# Currency Movement Dashboard (research)

**Status: UNVALIDATED research / decision support.** Movement scores are **not** trade signals,
probabilities of success, or evidence of profitability. No broker integration or automatic
execution. Price action only — no indicators, smoothed candles, currency-strength filters, or
LLM-generated signals. It answers: *which currency is moving, how broadly, how unusually, for how
long, and (when the news layer is populated) did expectations change* — kept separate from the
decision to enter a trade.

## What I found / reuse
- A dormant **CME** scaffold exists (`sql/012–015_cme*`) — SQL tables only, nothing wired. This module
  is the live engine/dashboard; it can later **persist into `cme_currency_movement_values`** via cron.
- Existing **currency-strength** engines (`strengthnet.js` zero-sum least-squares; `currency-strength-*-ema`)
  are **untouched** — this is a distinct MOVEMENT module (different, documented methodology).
- Reused: `backtest_candles` **M15** (the existing base dataset), the 28-pair list, the design system
  (`/paw1h4/styles.css`), the EAT/UTC + `?asOf=` replay conventions.

## Methodology (deterministic, configurable, versioned `cme-movement-1.0.0`)
- **Direction & magnitude:** per pair, `pair_return = ln(close_end / close_start)` over the window. Each
  currency takes **+return as base, −return as quote** (so a falling EUR/AUD is +AUD, −EUR).
- **Normalization:** each pair return ÷ the **rolling std of NON-OVERLAPPING same-horizon (candle-count)
  returns ending before the measured window** (no look-ahead). `< minSamples` or zero variance →
  **insufficient history** (excluded, never treated as 0). `maxSamples 60 / minSamples 20` (configurable).
- **Score:** the 7 signed normalized contributions aggregated with **equal weights** → the
  **normalized movement score** (not a probability or independent z-score). Raw returns + normalized
  values are preserved for inspection.
- **Direction class:** Strengthening / Weakening / Mixed via a visible **neutral band** (default 0.5).
- **Breadth:** count of pairs supporting strengthening / weakening / neutral (same band). **Coverage**
  (e.g. 6/7); missing/stale pairs are identified and **never counted as neutral**; incomplete currencies
  are **provisional**. Pairs share currencies and are correlated — breadth is **not** 7 independent confirmations.
- **Persistence:** recompute direction at successive completed M15 closes — consecutive same-direction
  count, supporting/total over the recent observations, and breadth trend (expanding/stable/contracting).
  Overlapping windows are correlated (not independent signals).
- **Onset (causal):** a qualifying obs needs |score| ≥ `scoreMin`, breadth support ≥ `breadthMin`, and the
  direction held ≥ `persistMin` consecutive obs. Records the **first** obs of the run and the obs where
  **confirmation first became possible** separately — never backdated. Shows episode **age**.
- **Extension:** |score| **percentile** vs the observed history (recent-window baseline) → *within usual
  range / elevated / unusually extended*. Inadequate history → **unavailable** (no misleading denominator).
  Does not imply reversal/continuation.
- **Windows:** 1h/4h/12h/24h (candles 4/16/48/96) + **5 trading days** (480). Measured in **trading time**
  (N completed M15 candles — equals clock time during continuous trading, compresses across weekend/holiday
  closures); the **actual start/end timestamps** are shown. Completed candles only; no forward-fill.

## Files
- `research/movement/config.js` — currencies, pairs, windows, versioned research defaults.
- `research/movement/engine.js` — series, window return, rolling-std normalization, per-currency score/breadth/coverage (common anchor; stale pairs excluded).
- `research/movement/analytics.js` — persistence, causal onset, extension (recompute at successive closes).
- `research/movement/payload.js` — dashboard payload (enriched table + cross-window heatmap + freshness + research action states).
- `research/movement/dbload.js` — read-only M15 loader.
- `api/currency-movement.js` — `?window=&currency=&asOf=` (maxDuration 60).
- `public/currency-movement.html` + `public/currency-movement/app.js` — dashboard. Routes `/currency-movement`, `/movement`.

## UI
Global controls (window selector, EAT replay picker + Live, analysis timestamp, data freshness/coverage,
timezone Africa/Dar_es_Salaam). **Main currency table** (Direction, Score, Breadth S/W/N, Persistence,
Detected onset/age, Extension, **Research action**, Coverage; sorted by |score|; provisional coverage
flagged). **Cross-window heatmap** (8×5, colour = direction, intensity ∝ |score|; conflicting horizons
obvious; tooltips: breadth/coverage). **Currency detail drawer** (seven pair contributions with correct
base/quote orientation + raw & normalized returns, movement-score sparkline, detected/confirmed onset,
extension, limitations). **Research action states** (Investigate movement / Await price-action setup /
Conflicting / Extended—review entry carefully / Insufficient data) — never automatic Buy/Sell. EAT+UTC;
causal `?asOf=` replay (identical live/historical calculations; verified no future leakage).

## Tests
`node --test tests/movement/*.test.js` — **12/12**: base/quote sign, common timestamp, horizon-appropriate
normalization, insufficient-history & zero-variance (not neutral), direction band, persistence, **causal
onset (first vs confirmed, not backdated)**, extension percentile, **no future leakage** (as-of invariance),
action states (no Buy/Sell), stale-pair freshness. No regressions: paw1h4/pad1h1 **58/58**, M15 **157/157**.

## News / expectations — status
Scaffolded but **not populated**. The dashboard surfaces `news.wired=false` and fundamental confirmation
shows **UNAVAILABLE**. Remaining to build: the three independent evidence layers (price / event / measured
expectations), CSV calendar import (`Title,Country,Date,Time,Impact,Forecast,Previous,URL` with an explicit
import timezone; raw import preserved; forecast-only until actuals exist), manual expectation snapshots with
source+timestamp, event↔movement before/after timing, and statuses (no event / possible association /
repricing observed / conflicting / insufficient). **Point-in-time historical** forecasts/actuals/revisions
do not exist yet, so historical fundamental confirmation must remain UNAVAILABLE in replay (price replay is
already causal). No LLM is used in any numerical calculation.

## Limitations
- M15 base; **5d** normalization needs long history — the live endpoint loads ~150 days (≈ enough for ≥20
  samples); a **cron precompute into `cme_currency_movement_values`** is the production path for deeper 5d
  history and instant loads.
- Equal-weight aggregation and the std baseline are **research defaults**, not optimized/validated.
- Breadth/persistence use overlapping, correlated windows — not independent confirmation.
- **Pair-comparison panel** (two currencies + their pair chart, selected-pair exclusion) and the **news
  subsystem** are the remaining pieces (data model/tables exist); both are documented follow-ups.
