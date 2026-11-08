# NervaFX — Trade Signal & Performance Module

**Status: research, MODELLED, UNVALIDATED.** Every signal and every performance figure is a
model output over historical **mid-price** candles. Execution is **estimated** (there is no
bid/ask history), results are simulated, and nothing here places a broker order. "Win rate" and
"return" describe a model, not a track record.

---

## 1. What it does

One configurable engine runs three independently-tracked strategies:

| Strategy | Select period | Confirm TF | Entry TF | Version |
|----------|---------------|-----------|----------|---------|
| **Today** | current day | H1 | M15 | `tsf-1.0.0` |
| **Week**  | current week (Mon) | H4 | H1 | `wsf-1.0.0` |
| **Month** | current month | D1 | H4 | `msf-1.0.0` |

Each strategy follows the same pipeline:

```
period comparison → top-3 pairs → confirm direction → entry trigger
  → publish (immutable) → model execution → track outcome → performance
```

- **Selection.** Each currency's period log return comes from the zero-sum 1/8 index
  (`research/comparison`). A pair's *differential* = `return(base) − return(quote)`. All 28 pairs
  are ranked by `|differential|` (ties broken by symbol); the top 3 are taken strictly — no
  4th-pair substitution. Bias is BUY if the differential is positive, SELL if negative.
- **Confirmation.** Uses the latest **fully completed** confirm candle (H1/H4/D1): BUY requires the
  base currency up with ≥5-of-7 breadth and the quote down with ≥5-of-7; SELL is the mirror. A zero
  reading never counts as support.
- **Trigger.** A 3-candle pattern on the entry TF (M15/H1/H4) with a Wilder **ATR(14)** stop placed
  `0.10·ATR` beyond the 3-candle extreme; the trigger is rejected if `range(t) > 2·ATR`. Target is
  **2R**; max hold **16 entry candles**; entry is cancelled if the fill deviates more than
  `0.25·ATR` from the reference.
- **Lifecycle.** `PUBLISHED → OPEN → CLOSED` (plus `EXPIRED` / `CANCELLED` / `UNRESOLVED`). The
  `signals` record is immutable; lifecycle changes are appended to `signal_events`; the mutable
  projection lives in `trade_outcomes`.

## 2. Period baselines — 00:00 EAT

Day, week and month baselines are anchored to **00:00 EAT (East Africa Time, UTC+3, no DST)**, the
app's display timezone — *not* 00:00 UTC. So "today" begins at local midnight in Nairobi (= 21:00
UTC the previous day), the week at Monday 00:00 EAT, and the month at the 1st 00:00 EAT. The
currency-comparison page and the signal engine share this boundary (`research/comparison/periods.js`)
so both surfaces agree on what "today/week/month" means.

## 3. Estimated execution & cost model

`backtest_candles` stores OANDA **mid** OHLC + tick volume only (M5/M15/H1; H4/D1 are aggregated
from H1). There is **no stored bid/ask or spread**, so execution is modelled, never observed:

- **Spread** — a per-pair typical spread (pips) from `COST_MODEL.spreadPips`, applied once per round
  trip; commission is folded into this assumption.
- **Slippage** — `0.3` pips applied adversely on each fill.
- **Financing/swap** — `−0.3` pips per calendar day held (long and short).
- **Geometry** in mid prices; costs are explicit deductions from gross P&L.

Intrabar stop/target monitoring uses the finest reliable data for each trade's window: **M5** where
present (≈ 2026-04 onward) else **M15**, disclosed per trade. On a bar that touches both stop and
target, the outcome is **stop-first** with the target-first alternative recorded as a sensitivity
(`altNetR`). Windows with no intrabar data resolve to **UNRESOLVED** (never fabricated).

Account return is conversion-free: risk is a fixed **0.5% of equity** per trade, so
`equity ×= (1 + riskPct · netR)`. The combined portfolio applies shared risk limits (2% aggregate,
1% per-currency) and conflict rules (one position per pair; opposite simultaneous signals skip both).

## 4. Causality (no look-ahead)

The index accumulates multiplicatively from the first observation and Wilder ATR depends only on
past true ranges, so a context built once over full history is readable at any `asOf` with no
look-ahead. Historical backfill and the live forward feed call the **same** evaluator; the only
difference is the `origin` label (`historical` vs `forward`) and the data window. This is covered by
`prefix-invariance`, `replay-cut`, and `historical/live parity` tests.

## 5. Versioning

Parameters are version-stamped (`strategy_versions`). **Changing any parameter creates a new
version row; published signals keep the version and frozen params they were created under** and are
never rewritten.

## 6. Data model (`sql/030_trade_signals.sql`)

`strategy_versions`, `signal_rankings` (one snapshot per decision), `signals` (immutable, unique on
`strategy_key,version,pair,entry_close_ms`), `signal_events` (append-only), `trade_outcomes`
(mutable projection), `signal_engine_cursor` (idempotent advance). RLS: service role full access,
authenticated users read-only.

## 7. Operating it

1. **Apply the migration** in the Supabase SQL Editor: run `sql/030_trade_signals.sql` once
   (idempotent). Until this is applied, the UI/API run on **live compute** (same engine, no
   persistence) and the forward feed is inactive.
2. **Backfill history** (idempotent; chunk by window to stay within 300s):
   `GET /api/backfill-signals?strategy=today&from=2025-05-01&to=2025-07-01` (repeat per window and
   per strategy). Auth: `Authorization: Bearer $CRON_SECRET`.
3. **Live feed** runs automatically — `vercel.json` cron hits `/api/cron-signals` every 15 minutes
   (offset from the candle-sync cron). It publishes new signals and advances open trades
   idempotently; `?force=1` bypasses the weekend-closed skip for manual catch-up.

Read API: `GET /api/trade-signals?view=all|board|current|history|performance|detail&strategy=&days=`.

## 8. Limitations

- Mid-only data → **estimated** execution; real spreads, slippage and swaps differ.
- Intrabar truth is bounded by M5/M15; sub-M5 stop/target ordering is unknown (hence stop-first +
  sensitivity).
- Simulated, unvalidated, single-account model portfolio; no partial fills, no liquidity modelling,
  no news/gap risk beyond what the candles already contain.
- **Not advice, not a probability, not a track record. No broker orders.**

## 9. Validation plan (§14)

- **Prefix-invariance** — decisions through `t` are identical whether or not future candles exist.
- **Replay-cut** — evaluating earlier hides later candles (baseline + ranking shift).
- **Historical/live parity** — the same engine yields identical trades under both origins.
- **Idempotency** — re-running a window never duplicates immutable signals/events and correctly
  advances the mutable outcome.

Run the suites:

```bash
node --test tests/signals/*.test.js
node --test tests/comparison/*.test.js
```
