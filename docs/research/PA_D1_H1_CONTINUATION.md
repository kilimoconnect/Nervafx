# PA_D1_H1_CONTINUATION — Daily → H1 pullback & continuation (research)

**Status: UNVALIDATED research hypothesis.** Implementation succeeding does not make it
validated. Stage 5/5A artifacts and the **NONE PASSED** verdict are unchanged; this is a
new, isolated hypothesis evaluated honestly below. No broker/order path; price action only.

Sibling strategy: [PA_W1_H4_CONTINUATION](PA_W1_H4_CONTINUATION.md) (Weekly → H4). The two
share one verified core and differ only in timeframe binding and config.

---

## 1. Architecture — shared core, separate results

The two continuation strategies reuse ONE deterministic, timeframe-agnostic core. Only the
two candle series (trend TF, entry TF) and the config (id/version) differ.

| Concern | Module | W1→H4 | **D1→H1** |
|---|---|---|---|
| Swing detection (strict 2-2 fractal) | `research/paw1h4/swings.js` | shared | shared |
| Structural trend + eligibility/invalidation | `research/paw1h4/weeklyTrend.js` | W1 candles | **D1 candles** |
| Continuation state machine | `research/paw1h4/engine.js` | shared | shared |
| Trade sim (entry/stop/target, costs) | `research/paw1h4/trade.js` | shared | shared |
| Metrics | `research/paw1h4/metrics.js` | shared | shared |
| Aggregation | `research/paw1h4/aggregate.js` | `h4()`, `w1()` | **`h1AsOf()`, `d1()`** |
| Pipeline (TF-parameterized) | `research/paw1h4/pipeline.js` | `TF_W1H4` | **`TF_D1H1`** |
| As-of frame | `research/paw1h4/frame.js` | shared | shared |
| Strategy binding + config | — | `research/paw1h4/config.js` | **`research/pad1h1/{config,index}.js`** |

Config/state/results are kept separate: `PA_D1_H1_CONTINUATION` / `pad1h1-1.0.0` with its own
deep-copied execution + swing settings, so tuning one strategy never leaks into the other.

M15 code and the Weekly→H4 strategy are untouched; existing research suite remains **157/157**.

## 2. Data integrity & boundaries (documented)

- **Entry = H1**, used directly from `backtest_candles` (completed ⇔ `closeMs ≤ t`).
- **Trend = D1**, aggregated from H1 on **UTC-day** boundaries (00:00 UTC → next 00:00 UTC).
  This is **DST-invariant by construction** — no broker-session drift. A broker daily close
  (e.g. 17:00 New York / 21:00–22:00 UTC, which moves with US DST) is a documented future
  option living only in config.
- A daily candle is **complete only when its UTC day has fully elapsed** as-of `t`; a forming
  day never establishes trend. Weekend days have no H1 and are simply **absent** (a scheduled
  closure, distinct from missing data). Days with fewer than 24 H1 are flagged `partial`
  (high/low still real; **never fabricated**).
- Causality: at `t`, only candles/pivots knowable by `t` are used. Verified: appending future
  candles does not change any already-emitted as-of output.
- Config is versioned; the swing fractal is fixed a priori (not tuned on returns).

## 3. Exact rules

**Swings (strict 2-2 fractal):** high/low strictly beyond the 2 candles either side; equal
extremes do not qualify; confirmed only when the 2nd following candle closes; extreme time and
confirmation time stored separately; a bar that is simultaneously swing-high and swing-low is
excluded from sequencing.

**Daily trend:** last two confirmed daily swing highs + lows → BULLISH (both rising), BEARISH
(both falling), NEUTRAL (conflicting), UNAVAILABLE (insufficient). Bullish invalidation = the
latest confirmed daily **higher low**; a completed daily close below it cancels eligibility
(mirror for bearish). After invalidation, re-eligibility requires a **newly confirmed** sequence
(latest defining high AND low both confirmed after the invalidation) — no reactivation from
unchanged pivots.

**Recent-candle break-of-structure precondition (v1.1):** a pullback setup is only *sought* when
the **most recent completed D1 candle** closes **in the trend direction** (bullish body in a
bullish trend) **and** **breaks structure** — its close is beyond the latest confirmed daily swing
in the trend direction (bullish: close > prior swing high; bearish: close < prior swing low). This
gates `WAITING_FOR_PULLBACK → PULLBACK_ACTIVE`. (Shared with Weekly→H4, which uses the recent W1
candle.) The pullback itself remains on the entry timeframe (H1 here / H4 there).

**H1 buy sequence (sell mirrored):** A) daily BULLISH *and the recent-D1-candle BOS precondition
holds* → B) a new H1 pullback of two descending
confirmed highs + two descending confirmed lows, its initial extreme after eligibility began →
C) freeze the latest H1 lower high; a completed H1 close above it = **FIRST_BREAK**; freeze the
lowest low of the pullback → D) after the break, a new confirmed H1 swing high, then a confirmed
H1 swing low **above** the frozen pullback low, in that order → E) freeze the new high = trigger,
the new higher low = stop reference → F) a subsequent H1 close above the trigger emits a manual
BUY; simulated entry = next H1 open. No backdating: a cross before the higher low confirmed does
not count; wait for a fresh qualifying close.

**Lifecycle states:** UNAVAILABLE, NEUTRAL, WAITING_FOR_PULLBACK, PULLBACK_ACTIVE, FIRST_BREAK,
WAITING_FOR_RETEST_STRUCTURE, ARMED, TRIGGERED, CANCELLED, EXPIRED. Cancel before entry on: lost
daily eligibility/invalidation; breach of the frozen pullback extreme; (once armed) breach of the
stop reference. **Cancellation beats triggering in the same candle.** Expiry = 30 completed H1
candles after FIRST_BREAK (unvalidated setting). One opportunity per pullback episode; re-arming
requires a new sequence.

**Trade:** entry = next H1 open; stop = beyond the H1 higher-low/lower-high by an instrument-aware
buffer; target = **nearest opposing confirmed daily swing beyond entry, known at signal**; reject
if no target or estimated **R:R < 2:1 after costs**; gap recheck at the actual entry open; stop &
target frozen after entry; time exit after 30 H1 bars; conservative **stop-first** when one candle
spans both; costs = spread + slippage + commission (+ optional financing). Hypothetical sizing
0.25% equity/trade. No averaging/martingale/trailing/auto-break-even. Manual only.

## 4. Verification

`node --test tests/pad1h1/*.test.js` (4) + the shared `tests/paw1h4/*.test.js` (35) cover: strict
2-2 fractal (extreme vs confirmation time, equal-extreme rejection, bothSide exclusion, as-of
causality); D1 & H1 aggregation (UTC-day buckets, completed-only, partial flagging, no fabrication);
the full state machine — clean long, **mirrored short**, cancellation (pullback-extreme breach,
stop breach, eligibility loss), **cancellation priority over trigger**, expiry, no-backdate guard;
trade sim (target selection, 2:1 gate, gap invalidation, stop-first ambiguity, time exit); metrics;
and **as-of stability** (future candles cannot alter prior outputs). The engine is identical to
W1→H4, so those guarantees transfer directly.

## 5. Actual evaluation (real data)

Data: stored **H1** for the 28 majors, **2025-05-19 → 2026-10-16 (~17 months)**; D1 aggregated.
Economics **mid-only, estimated** (spread 1.2p, slippage 0.5p, 2p buffer; 2× sensitivity run).
Report: `docs/research/pad1h1_backtest.json`. Run: `node scripts/research/pad1h1-backtest.js`.

Figures below are **v1.1 — with the recent-candle break-of-structure precondition** (§3). It makes
both strategies much more selective (far fewer setups than v1.0).

| Variant | n | Expectancy | Profit factor | Win | Max DD | Loss streak |
|---|---:|---:|---:|---:|---:|---:|
| **D1→H1 (daily-filtered)** | 7 | **+0.196R** | 1.27 | 29% | 5.18R | 5 |
| Comparison: H1-only (no daily filter) | 27 | **−0.636R** | 0.26 | 11% | 17.17R | 11 |
| Comparison: daily-structure baseline | 0 | — | — | — | — | — |
| **OOS (last 40% of signals)** | 4 | +1.117R | 3.14 | 50% | 2.09R | 2 |
| D1→H1 @ **doubled costs** | 7 | +0.088R | 1.11 | 29% | 5.35R | 5 |
| Weekly→H4 (same period) | 2 | −0.209R | 0.59 | 50% | 1.01R | 1 |
| **Combined, naïve pooled** (not independent) | 9 | +0.107R | 1.15 | 33% | 5.18R | 5 |

Rejections (daily): `rr_below_min` 63, `no_target` 40 — the BOS precondition removes most pullbacks
up front, and the 2:1 gate against the *nearest* opposing daily level filters most of the rest.

**Honest read:**
- The **daily filter clearly helps**: unfiltered H1 continuation is sharply negative
  (−0.64R, PF 0.26) while the daily-filtered version is positive in-sample (+0.20R).
- The **recent-candle BOS precondition** (v1.1) cut trades from 21 → **7** and lifted per-trade
  expectancy — fewer, cleaner setups — but it leaves **almost no sample**. The OOS slice is nominally
  strong (**+1.12R**) but is only **4 trades**, so it is noise, not evidence.
- **Sample is far too small** (7 trades / 17 months / 28 pairs) to conclude anything. Treat all of it
  as **exploratory**. No profitability is claimed; nothing here earns a forecasting display.

## 6. Combined-portfolio caveat

The two models read the **same price data** and overlap in time and currencies, so concurrent
signals are **not independent confirmation** and must not be pooled as if uncorrelated. In this
sample: **0** overlapping same-pair opportunities; shared-currency max concurrent exposure **1** per
currency. Keep per-strategy results separate; the pooled row above is illustrative, not a portfolio
claim.

## 7. UI

`/daily-h1` (`public/pad1h1.html`, API `/api/pad1h1`) renders D1 + H1 charts (confirmed-swing
markers, invalidation / break / pullback-extreme / trigger / stop lines), the daily trend card
(with separate extreme vs confirmation timestamps), the H1 state machine, the suggested trade (or
rejection reason), data-quality warnings, UTC + EAT timestamps, `?asOf=` replay (strictly causal),
and a **same-pair comparison** with Weekly→H4 carrying the not-independent caveat. The renderer
(`public/paw1h4/app.js`) is shared and label-driven.

## 8. Limitations & blockers

- Short history → tiny trade counts; results are exploratory, not validated.
- D1/H1 are UTC-anchored aggregates of stored H1; a broker-session daily close is a future option.
- OANDA **tick** volume only (unused — no volume signals by design).
- Live tradability, true spreads/financing and OOS robustness remain unproven. No migrations were
  applied and nothing was deployed/pushed/scheduled, per task.
