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
Identical to PA_D1_H1_CONTINUATION §3 with Weekly/H4 substituted: strict 2-2 fractal swings;
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

| Variant | n | Expectancy | PF | Win | Max DD | Streak |
|---|---:|---:|---:|---:|---:|---:|
| **Weekly-filtered** | 14 | +0.202R | 1.36 | 43% | 4.74R | 5 |
| H4-only (no weekly filter) | 11 | +0.545R | 2.17 | 55% | 2.05R | 2 |
| Weekly-structure baseline | 0 | — | — | — | — | — |
| OOS (last 40%) | 5 | +0.237R | 1.57 | 60% | 1.05R | 1 |
| @ doubled costs | 14 | +0.150R | 1.26 | 43% | 4.91R | 5 |

**Honest read:** marginally positive in-sample and holds its (tiny) OOS slice, but with only
**14 trades** it is not remotely significant. Notably the **unfiltered H4** variant scored better
here — i.e. the weekly filter did not add measurable value on this sample (opposite of the D1→H1
result). `rr_below_min` dominates rejections. Exploratory only; no profitability claimed.

## UI
`/weekly-h4` (`public/paw1h4.html`, API `/api/paw1h4`): W1 + H4 charts with swing markers and
frozen levels, weekly trend card (separate extreme/confirmation times), H4 state machine, suggested
trade / rejection, data-quality, UTC + EAT, `?asOf=` causal replay.
