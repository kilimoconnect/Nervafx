# NervaFX Inverted Flow Chart

A custom Renko-style chart where a block's **height** is a fixed price step, its **width** is the
number of eligible observations it took (feed activity), and a thin **trace** shows the observed path
inside each block. 36 selectable charts: the 28 FX pairs + the 8 zero-sum currency indices.

Research / relative-movement only — **no orders, no buy/sell signal, no probability or profitability
claim.** Width is **feed activity**, not traded lots, monetary volume, or buyer/seller identity.

## Files
- `config.js` — 36 instruments, pip sizes/precision, default step (5 pips, a *display* preset),
  index step (0.05 pp). `blocks.js` — the deterministic engine. `observations.js` — stream builders
  (`closeObs`, `indexObs`, `simulatedEURUSD`). `coverage.js` — usable range + gaps.
- `api/inverted-flow.js` — the endpoint. `public/inverted-flow.html` + `public/inverted-flow/flow.js`
  — the page, custom SVG renderer, client engine (for replay), controls. Routes `/inverted-flow`, `/flow`.
- Tests: `tests/flow/{blocks,index}.test.js` (`node --test`).

## The block rule (height = step S, confirmed in integer step-units from a stable anchor)
Let `C` = last confirmed block close. Equality counts as a crossing.
- **First block:** `|value − anchor| ≥ S` → body `anchor → anchor ± S`.
- **Dir UP:** `≥ C+S` → up continuation `C → C+S`; `≤ C−2S` → **down reversal**, red body `C−S → C−2S`.
- **Dir DOWN:** `≤ C−S` → down continuation `C → C−S`; `≥ C+2S` → **up reversal**, green body `C+S → C+2S`.
- **Activity ownership:** count observations after the prior confirmation, up to and *including* the
  confirming one (counted once); it starts the next trace without adding a unit.
- **Multi-level jump:** one update crossing several thresholds → all crossed levels in order as **one
  event**, activity counted once.
- **Forming:** while unconfirmed, the trace + width keep growing (dashed, hollow latest marker), using
  only the prefix reached. On confirm, geometry/timestamp/activity freeze.
- The anchor is tied to a documented `since`/day baseline, **not the visible window**, so refresh,
  zoom and date changes reproduce identical blocks. (5-pip step ⇒ a 10-pip, 2-step reversal — the
  reference example.)

## Two honest data modes
NervaFX stores **completed midpoint OHLC candles only** (M5/M15/H1, OANDA `price=M`, `complete=true`).
There is **no bid/ask, no tick table, and no live tick feed** (the EA endpoints carry account
balance, not prices; "live" = the latest completed candle, refreshed every 15 min by
`cron-backtest-sync`). Therefore:

- **Close-only mode (all 36 real instruments).** One completed close = one horizontal unit; the
  resolution is labelled ("M5 closes"). Markers sit on observed closes; the line between them is a
  visual connection only. **No intrabar path, tick count, spread or reversal time is fabricated from
  OHLCV.** Indices advance one unit per synchronized 28-pair M15 basket snapshot.
- **Simulated example (quote mode).** The labelled A–D EUR/USD sequence is the *only* quote-by-quote
  view — the honest way to show quote-mode behaviour (width = quote updates, retreats, multi-level
  jumps, forming, reversal marker) without inventing quotes on broker history.

## Currency indices
Reuse the existing zero-sum **1/8** index (`research/comparison/index-build.js`): `r_c = (Σ leg.sign·
ln(close_t/close_{t-1}))/8`, synchronized across all 28 pairs. The chart rebases it to the daily
baseline (00:00 EAT) as **percentage points**; by construction the values reconcile with the Evolution
engine. Width = constituent basket snapshots. Default "Today So Far"; `?date=` picks a past day; a
daily reset starts a new series and never creates a reversal or jump.

## Verified coverage (read from the data, 2026-11-21)
All 28 pairs have the same stored ranges; indices derive from the 28-pair M15 basket.

| Resolution | Earliest | Latest | Notes |
|---|---|---|---|
| **H1** | 2025-05-19 | 2026-11-20 | ~18 months (confirms the "May 2025" expectation — **verified**, not assumed) |
| **M15** | 2025-05-19 | 2026-11-20 | same depth as H1; the index basket uses M15 |
| **M5** | 2026-04-05 | 2026-11-20 | finest resolution, ~7.5 months of history |

Index (28-pair M15 intersection, last 45 days sampled): 3,118 complete basket snapshots, weekend gaps
only (7). A complete 8-currency index needs all 28 pairs present at a timestamp — available across the
M15 range; weekends/holidays appear as visible gaps, never filled.

## What was verified, and on what data
- **On completed candles (real data):** all 28 pair charts and 8 index charts render; close-only
  blocks, variable widths, coverage, weekend gaps; a 2-days-ago `asOf` replay is a strict prefix of
  the live result (**no look-ahead**); the index reconciles with the Evolution ranking.
- **On the simulated A–D sequence:** exact levels/widths/reversal timing (A green 1.0830→1.0835 ×20;
  B green 1.0835→1.0840 ×80; C red reversal 1.0835→1.0830 ×55 with the 1.0843 peak retained; D forming
  1.0830→1.0827 ×20); the reversal marker reads "Downward reversal confirmed · 1.08300"; replay keeps C
  unconfirmed until its 55th update.
- **On real quotes: nothing — because NervaFX stores none.** Exact tick paths and tick counts are
  never claimed for candle history; quote-mode semantics are demonstrated only on the labelled
  simulation.

## Limitations
- Width is feed activity (received closes / basket snapshots / — in the simulation — quote updates),
  not volume or order flow. In close-only mode a block's "activity" is how many completed closes it
  spanned, which depends on the chosen resolution.
- The 5-pip default step is a display preset; its trading performance is not established.
- Close-only reversals become observable only at candle completion; intrabar ordering is unknown and
  not shown. Gaps (weekends/holidays/outages) are marked; a crossing first seen after a gap is flagged
  and the in-gap timing is not implied.
