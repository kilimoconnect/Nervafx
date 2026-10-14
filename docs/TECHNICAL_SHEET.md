# NervaFX M15 — Technical Sheet

**Status:** analytical / manual · **Model:** UNVALIDATED (no demonstrated edge) · **No orders, broker, buy/sell signals, or profitability claim.**
Last updated 2026-10-15.

---

## 1. What the system is
A read-only **M15 (15-minute) foreign-exchange analytics and manual-decision workspace** covering the
**28 major pairs / 8 currencies** (USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF). It describes market
structure and currency strength from **completed M15 candles only**, using a **past-only adaptive
scale** — no conventional indicators (EMA/RSI), no volume in the engine, no candlestick names, no
fixed-pip rules. Every reading is causal (no look-ahead) and immutable as-of its candle close.

It is **descriptive**, not predictive: the model is UNVALIDATED, and **no forecasting display is
enabled** anywhere in the product.

---

## 2. Architecture at a glance

```
OANDA (mid M15) ──cron──▶ Supabase: backtest_candles ──▶ Vercel serverless API ──▶ static workspace (browser)
                 every 15m        (durable raw input)        /api/m15-workspace        /app  (vanilla JS + canvas)
```

- **Frontend:** static HTML + vanilla JS (no framework/bundler), canvas charts, Inter font.
- **Backend:** Vercel serverless functions (Node, CommonJS) under `api/*.js`.
- **Data store:** Supabase (Postgres) — `backtest_candles` is the single durable input.
- **Research engine:** pure, deterministic, versioned modules under `research/m15/` (no I/O), unit-tested.
- **Dependencies:** `@supabase/supabase-js`, `dotenv`, `express`, `node-cron`, `openai`, `ws`.

Isolation principle: all analytics live in the `research/m15/` namespace and are pure functions; the
API is a thin read-only adapter; the old production "M15 Intelligence" engine was removed and replaced
by the research classifier.

---

## 3. Data layer
- **Table:** `backtest_candles` — mid OHLC, tick volume, `complete`, `source` (OANDA), `timeframe` M15, `instrument`.
- **Ingestion:** `api/cron-backtest-sync.js`, scheduled **every 15 minutes** (`*/15 * * * *`, aligned to M15 closes), `maxDuration` 300 s.
- **Pipeline:** `api/run-pipeline.js`, hourly at **:03** (`3 * * * *`), `maxDuration` 120 s.
- **Loader:** `research/m15/loader.js`
  - `loadAllPairsFromDb(sb, {pairs, fromIso, toIso})` — loads 28 pairs **in parallel**, paginated.
  - `syncAsOf(H, now)` — finds the latest **synchronized** completed close across all pairs (no look-ahead).
  - `toCandle` carries `volume`; `prepare(cands, T)` filters incomplete/future bars, dedupes, reports gaps.
- **Economics:** mid-only; **no bid/ask** → all cost/profitability conclusions are UNAVAILABLE by design.

---

## 4. Research engine (`research/m15/`) — pure, versioned

| Module | Version | Purpose |
|---|---|---|
| `priceaction.js` | `m15-pa-1.0.0` (thresholds `swing-k1.5-medabs-v1`) | Single-pair causal descriptor: 12/24/36/48h windows (efficiency, direction, range, position-in-range, overlap), swing pivots, balance-zone lifecycle, event log |
| `strengthnet.js` | — | Zero-sum 8-currency strength via least squares over pair log-returns; leave-one-pair-out "other-pair" confirmation; per-window (12/24/36/48h) |
| `classifier.js` | `m15-classifier-1.0.0` (calibration `cal-v1`) | Composes the above into explained states; no entry/exit rules |
| `balanceBreak.js` | `accepted-balance-break-1.0.0` | Accepted balance-break pattern |
| `failedBreak.js` | `failed-balance-break-1.0.0` | Failed balance-break pattern (built on the accepted break) |
| `pullback.js` | `trend-pullback-continuation-1.0.0` | Trend pullback continuation pattern (built on swing pivots) |
| `workspaceFrame.js` | `m15-workspace-1.1.0` | Builds the per-close workspace payload (frames) consumed by the UI |
| `*_outcome_prereg.js` | frozen + hashed | Pre-registered outcome studies (see §8) |
| `infocontent*.js`, `health.js`, `features*.js`, `candidates.js`, `walkforward.js`, `experiment.js`, `registry.js`, `backtest.js` | — | Research/audit tooling (info-content study, data health, feature/candidate exploration, walk-forward) |

### 4.1 Price action primitives
- **Adaptive scale:** `medAbsDelta` = median \|Δclose\|; window/pivot thresholds are multiples of it (past-only).
- **Swing pivots** (`detectSwings`, k=1.5): causal zig-zag — an extreme becomes a CONFIRMED pivot only once price retraces by `k·scale`; a pivot is **known at its confirmation bar**, not its extreme bar.
- **Balance zone** (`balanceLifecycle`): band `[center ± tol]`, `tol = 1.0·medAbsDelta` over 48h, formed after ≥3 inside closes; lifecycle events `BALANCE_FORMED → DEPARTURE_PROVISIONAL → DEPARTURE_ACCEPTED / RETURN / TEST / REJECTION / CONTINUATION`.

### 4.2 Currency strength network
- For pair `BASE_QUOTE`, observed `r = x_base − x_quote`; solve the over-determined system for per-currency `x` (zero-sum) by least squares, per window (12/24/36/48h).
- **Other-pair confirmation** = leave-one-pair-out re-estimate (excludes the pair under test). Labelled **other-pair support**, explicitly *not* statistical independence (currencies are correlated).

### 4.3 Classifier states
`BALANCED_RANGE`, `EMERGING_MOVE_UP/DOWN`, `ACCEPTED_TREND_UP/DOWN`, `ACCELERATING_TREND_*`,
`EXHAUSTION_RISK_*`, `REVERSAL_UP/DOWN`, `CONFLICT`, `UNAVAILABLE`. The UI simplifies these to
**Range / Developing trend / Established trend / Reversal / Conflict / Unavailable** with
Accelerating/Extended/Exhaustion as qualifiers; the detailed engine state is shown in the evidence panel.

---

## 5. Structure patterns (three, shared schema)

Each is deterministic, versioned, causal; shares the price context (12/24/36/48h), other-pair strength,
supporting/opposing evidence, a structural invalidation reference; states **FORMING / CONFIRMED /
INVALIDATED / UNAVAILABLE**; confirmation is stamped on the candle that first makes it observable
(never backdated); gaps break contiguity and withhold confirmation.

| Pattern | Starts from | CONFIRMED when | Invalidation reference |
|---|---|---|---|
| **Accepted balance break** | zone + close-beyond departure | 2 contiguous closes beyond (or held retest) | breached edge (anchored at the provisional close) |
| **Failed balance break** | an attempted departure (built on accepted break) | 2 contiguous closes reclaimed back inside | a fresh accepted break beyond the edge again |
| **Trend pullback continuation** | accepted higher-high/lower-low swing structure | 2 contiguous closes beyond the prior swing extreme | prior higher-low / lower-high structural level |

Consistency: the accepted-break and failed-break labels cannot report contradictory current states — a
failure confirms exactly when the accepted break is reclaimed, and the transition is stated. Patterns
are surfaced per pair; the watchlist flags active patterns (`break / failed / pullback`) and floats
those pairs to the top.

---

## 6. Workspace frontend (`/app`)

Served from `public/m15-workspace.html` + `public/m15-workspace/{app.js, adapters.js, styles.css}`,
login-gated, fetching `/api/m15-workspace` into the same contract the fixtures use.

**Views:**
1. **Market review** — freshness header, watchlist (ranked by move strength, pattern column), candlestick chart (+ EAT time axis, crosshair, tick-volume sub-panel, pattern markers), four-window price/strength matrix, **currency strength by window (12/24/36/48h)** with development (gaining/holding/losing), decision summary (simplified state), **direction-vs-timing**, strongest-alternative view, supporting/opposing evidence, pattern cards, decision recording.
2. **Pair detail** — causal event chronology, latest-vs-preceding-12h; chart lookback is visual-only.
3. **Replay** — step one completed candle at a time; future events hidden.
4. **Journal** — pre-outcome snapshots (close, versions, input digest, evidence) in `localStorage`; add observed market / trade (label only) / rule-adherence outcomes later; **prospective recorder** logs each close's classification before outcomes and resolves continuation vs reversal across sessions.
5. **Model & health** — UNVALIDATED verdict, Stage 5/5A NONE PASSED, info-content INSUFFICIENT_EVIDENCE + why, reproducibility (input digest + versions), data health, and **"NO RELIABLE FORECAST — display not enabled."**
6. **Plan & risk** — honest **UNAVAILABLE** (no account/instrument/cost/position contract).

**Freshness contract:** three timestamps (last closed candle, last ingestion, analysis completion) + missing-closed-candle count + DELAYED/UP-TO-DATE/CLOSED badge. The page auto-refreshes ~75 s after each M15 close (paused in historical mode). **Historical selection:** `?asOf=<ms>` (EAT picker) rebuilds the workspace as of any past close, causally (no candles after `asOf` loaded).

---

## 7. API & routing

| Route | Serves |
|---|---|
| `/app`, `/workspace`, `/m15-intelligence` | `m15-workspace.html` (the live workspace) |
| `/m15-board` | `m15-intelligence.html` (internal diagnostic classifier board) |

**Endpoints:**
- `GET /api/m15-workspace` — read-only; loads real 28-pair M15, builds per-close frames (default 40, `?frames=N`; `?asOf=<ms|ISO>` for historical). `maxDuration` 60 s.
- `GET /api/m15-intelligence` — read-only classifier board (fallback/diagnostic).
- Legacy standalone analytics (`m15-energy/impulse/quality/spreads/strength-*`) remain but are not part of the workspace flow.

No endpoint writes to the DB from the workspace path; no order/broker path exists anywhere.

---

## 8. Outcome studies (frozen, pre-registered)
Each is registered **before** evaluation, hashed (`SPEC_HASH`), and evaluated only chronologically
out-of-sample. **No predictive probability** until produced and calibrated on unseen data; **economics
UNAVAILABLE** without bid/ask.

- `balanceBreak_outcome_prereg.js`, `failedBreak_outcome_prereg.js` — per-pattern.
- `patterns_outcome_prereg.js` — **integrated** study of all three: horizons **4 & 16** candles; baselines = classifier / unconditional / cross-pattern; dedup by `patternId` + non-overlapping subsample; chronological OOS with a **16-candle embargo** (≥ max horizon) to prevent forecast-window leakage; metrics = sample sizes, directional continuation, **Wilson 95% intervals**, pair & session (EAT) breakdowns, delta vs classifier; weak/inconsistent ⇒ display **"no reliable forecast."**
- The pre-registration decision function `decideDisplay()` currently returns **NO_RELIABLE_FORECAST** — no OOS evaluation has been run.

---

## 9. Validation status (preserved, immutable)
- **Stage 5 / 5A:** **NONE PASSED** (no profitable strategy demonstrated).
- **Info-content (`infocontent*`):** H1/H2/H3 = **INSUFFICIENT_EVIDENCE**; economics ESTIMATED (mid-only); pre-registration hashed.
- **Model status:** **UNVALIDATED.** No profitability, win-rate, or confidence probability is shown anywhere.
- **Forecasting display:** **not enabled** — the three patterns are descriptive structure only.

---

## 10. Testing, determinism, reproducibility
- **Research test suite:** `node --test tests/research/*.test.js` → **146 pass / 0 fail**.
- Coverage includes causality/no-look-ahead replay, each pattern's scenarios (genuine/forming/re-entry/retest/gap/missing-data/wick-only), the strength network, the classifier states, and the frozen studies.
- **Determinism:** pure functions; identical inputs → identical outputs.
- **Reproducibility:** every frame/journal entry pins `inputDigest` (hash of the pair's closes up to T) + classifier/calibration/code versions, so revised candles or thresholds cannot silently rewrite an old interpretation.

---

## 11. Constraints & safety
- M15 prices + 12/24/36/48h context **only**; no EMA/RSI/volume-in-engine/candlestick-names/fixed-pips.
- Completed candles only; causal, immutable as-of close.
- Read-only; **no orders, broker connection, buy/sell signals, alerts, or profitability claim.**
- Explicit states on failure (loading / unavailable / stale / closed-market / conflict / error) — **no hidden fill-forward or synthetic fallback**; on API error the UI shows an explicit error state.

---

## 12. Deployment
- **Host:** Vercel (static assets + serverless functions); GitHub repo `kilimoconnect/Nervafx`, branch `master`.
- **Env:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service-role, server-side only).
- **Crons:** `cron-backtest-sync` `*/15 * * * *`; `run-pipeline` `3 * * * *`.
- **Build note:** a "Git information retrieval failed" build error is a Vercel↔GitHub integration issue (pre-build), fixed by redeploying or reconnecting the Git integration — not a code fault.

---

## 13. Known gaps / roadmap
- The frozen outcome studies have **not** been run on real OOS data (no market-data access in the build env) — results PENDING; **no pattern has earned a forecasting display.**
- Plan & risk stays UNAVAILABLE pending an account/instrument/cost/position contract.
- Prospective evaluation is **per-browser** (localStorage), not a shared server-side store.
- Legacy standalone M15 analytics pages remain in the repo (not in the workspace flow).
- Pre-existing: `npm run test:m15` references the retired `api/_m15` engine and is obsolete.
