# M15 Strategy Research — Stage 4 handoff (realistic read-only replay & outcomes)

Read-only, every-M15-close offline replay over the verified range, using Stage 1's
loader (no-lookahead), Stage 2's features, and Stage 3's frozen registry. Production
market data, strategy state, and tables are untouched; this runs offline, never in a
Vercel request. **No best strategy is named. Every economic result is ESTIMATED
(mid-only data) — never confirmed.**

- Engine: `research/m15/backtest.js` (pure outcomes) + `scripts/research/backtest-run.js` (driver).
- Result file (local): `docs/research/stage4_backtest.json`.
- Tests: `node --test tests/research/*.test.js` → **36 pass / 0 fail** (loader 9, features 10, registry 9, outcomes 8).

## Exact run command (reproducible)
```bash
node scripts/research/backtest-run.js --from 2026-07-01 --to 2026-09-25   # validation window
node scripts/research/backtest-run.js --from 2025-05-19 --to 2026-09-25   # full verified range
```
Every result is tied to a reproducible **candidate ruleHash + engine version
(`m15-cfg-1.1.0a`) + feature version (`m15-feat-1.0.0`) + data window + cost scenario**.

## Predeclared REFERENCE simulation (one open position per pair)
- **Entry:** the OPEN of the candle **one M15 after** the signal (earliest realistic
  manual quote) — **never the signal close**; a non-contiguous next candle
  (weekend/gap) is **excluded** (`STALE_GAP_EXCLUDED`), never filled post-gap.
- **Protective risk:** M15 **ATR14 × 1.0** stop → defines R.
- **Hold:** max **4 M15 candles (1 hour)**; exit at stop or timeout close.
- **Gap:** a bar that OPENS beyond the stop exits at the (worse) open.
- **Same-bar ambiguity:** a bar merely TOUCHING the stop is resolved **conservatively
  as a stop** (never in the trade's favour). Because data is mid-only OHLC, intrabar
  ordering is treated as ambiguous and never optimistic.
- **Spread/slippage (mid-only ⇒ modelled):** scenarios **0.0 (mid, optimistic) /
  1.2 (typical) / 2.4 (2× stress)** pips, one full round trip subtracted from mid
  P&L. Reported separately; **all labelled estimated**.
- **Sensitivities:** a **one-more-candle manual delay** (delay 2) and the **increased-
  spread stress** are both run.
- Later entry/exit variants (e.g. limit-at-close with real no-fill) are **separately
  registered**, not folded into the reference.

## Two denominators (kept separate)
1. **Pair-at-close evaluations** = closes × 28 (in `denominators`).
2. **Unique setup episodes** per candidate — repeated signals on successive closes are
   ONE episode until timeout/invalidation permits another. Correlated same-currency
   pairs are reported by base/quote currency and session and are **not** counted as
   independent successes.

## What is reported (per candidate × variant)
- **Direction (edge), SEPARATE from economics:** forward 4/6/8/10-bar mid movement and
  direction-accuracy fraction.
- **Trade economics (ESTIMATED):** avg net R at each spread scenario + delay-2, win
  rate, avg gross pips, **cost break-even spread (pips)** = avg gross pips (net = 0
  when spread equals it), avg MAE/MFE in R, ambiguous share, filled/stale/no-data
  counts, and distribution by session / base / quote currency.
- A **control** (pseudo-random) and a **no-signal** option bound spurious performance.

## Illustrative validation slice (7 days, 2026-09-18→25 — small, not a conclusion)
756 closes · 21,168 pair-at-close evals. Direction accuracy ~0.42–0.55 (near
coin-flip); **net R after typical spread was NEGATIVE for every candidate, including
the pseudo-random control (~−0.31R)** and the best-directional family. E/F produced 0
episodes in one week (rare states). This is a *slice*, not a verdict — see the full
validation-window results in `stage4_backtest.json`.

## Parity
No stored feature/decision snapshots exist yet (`m15i_*` tables are empty — the
scheduler is not live). Replay-vs-stored parity is therefore **UNTESTED and labelled
so**. The replay is internally deterministic and reproducible from frozen inputs.

## Data / cost coverage & exclusions
Mid-only OANDA M15 (no bid/ask ⇒ spread modelled, not measured); tick volume ≠ trading
volume; ~0.58% intraday gaps and 533 outlier spikes flagged (Stage 1). Excluded from
economics: `STALE_GAP_EXCLUDED` (non-contiguous entry) and `NO_DATA_ENTRY` (end of
data). Data snapshot hash `84405f31dc880be4`.

## Stage 5 readiness
The replay/outcome engine is deterministic, cost-transparent, and reproducible;
denominators are separated; direction and economics are reported apart. Stage 5 should
apply a **predeclared prospective/holdout split**, compute significance vs the control
and no-signal, correct for the enumerated 15-variant trial count (multiple-comparison
/ overfitting), and only then form a keep/continue/stop view — **without** re-selecting
rules on the same data. **No winner is claimed. Stop after Stage 4.**
