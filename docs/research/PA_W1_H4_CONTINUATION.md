# PA_W1_H4_CONTINUATION — Weekly → H4 pullback & continuation (research)

**Status: UNVALIDATED research hypothesis.** Stage 5/5A artifacts and **NONE PASSED** are
unchanged. Price action only; no broker/order path. Sibling: [PA_D1_H1_CONTINUATION](PA_D1_H1_CONTINUATION.md),
which shares the same verified core (see that doc §1 for the architecture and the exact rules —
they are identical except Weekly replaces Daily and H4 replaces H1).

## Timeframe binding
- **Entry = H4**, aggregated from stored H1 on fixed **UTC 4h** buckets (00/04/08/12/16/20).
- **Trend = W1**, aggregated on the **UTC week** (Monday 00:00 UTC → next Monday 00:00 UTC).
- UTC-anchored ⇒ **DST-invariant**; completed-only; partial buckets flagged, never fabricated.
- Config: `PA_W1_H4_CONTINUATION` / `paw1h4-1.0.0` (`research/paw1h4/config.js`).

## Rules
Identical to PA_D1_H1_CONTINUATION §3 with Weekly/H4 substituted, **including the recent-candle
break-of-structure precondition** (the most recent completed **W1** candle must close in the trend
direction and break the prior weekly structural swing before an H4 pullback is sought): strict 2-2
fractal swings;
weekly structural trend + higher-low/lower-high invalidation with no-reactivation-from-old-pivots;
H4 pullback → first break → retest structure → continuation trigger; 10-state lifecycle with
cancellation-priority, 30-H4-bar expiry, one-per-episode, no-backdate; trade entry/stop, nearest
opposing **weekly** target, 2:1-after-costs gate, gap recheck, frozen stop/target, 30-bar time
exit, conservative stop-first.

## Verification
`node --test tests/paw1h4/*.test.js` — **35/35** (swings, D1/H4/W1 aggregation, full engine
behaviours incl. mirrored short / cancellation priority / expiry / no-backdate, weekly trend
incl. invalidation & no-reactivation, trade sim, metrics, as-of causality). M15 suite untouched
(157/157).

## Actual evaluation (real data, 28 majors, ~17 months H1)
Report: `docs/research/paw1h4_backtest.json`; run `node scripts/research/paw1h4-backtest.js`.
Economics mid-only estimated.

Figures are **v1.1 — with the recent-W1-candle break-of-structure precondition**.

| Variant | n | Expectancy | PF | Win | Max DD | Streak |
|---|---:|---:|---:|---:|---:|---:|
| **Weekly-filtered** | 2 | −0.209R | 0.59 | 50% | 1.01R | 1 |
| H4-only (no weekly filter) | 11 | +0.545R | 2.17 | 55% | 2.05R | 2 |
| Weekly-structure baseline | 0 | — | — | — | — | — |
| OOS (last 40%) | 2 | −0.209R | 0.59 | 50% | 1.01R | 1 |
| @ doubled costs | 2 | −0.243R | 0.52 | 50% | 1.02R | 1 |

**Honest read:** the recent-W1-candle BOS precondition is extremely restrictive on the weekly
timeframe — it leaves just **2 trades** in 17 months (negative). That is **no sample at all**; nothing
can be concluded. The unfiltered H4 variant (11 trades, +0.55R) only shows that most of the activity
lives below the weekly structure. Exploratory only; no profitability claimed. (The gate is more
productive on D1→H1 — see that doc — but still far too few trades.)

## UI
`/weekly-h4` (`public/paw1h4.html`, API `/api/paw1h4`): W1 + H4 charts with swing markers and
frozen levels, weekly trend card (separate extreme/confirmation times), H4 state machine, suggested
trade / rejection, data-quality, UTC + EAT, `?asOf=` causal replay.
