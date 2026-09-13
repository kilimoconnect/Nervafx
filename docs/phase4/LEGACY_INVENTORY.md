# Phase 4 — Legacy inventory & reversible separation plan (no deletion)

Goal (§5): inventory the old H1/multi-timeframe surface, prepare a **reversible**
`strategy_generation = LEGACY` label for records of **known provenance**, and mark
old pages Legacy **without** breaking bookmarks, disabling processing, or deleting
anything. Nothing here is applied — it is a plan for owner-controlled rollout after
the M15 replacement is verified.

## Legacy pages / routes still live (preserve URLs)
| Route | Page | Basis (non‑M15‑intelligence) |
|---|---|---|
| `/market-pressure` | market-pressure.html | D1/H4/H1 multi‑TF pressure |
| `/structure-break` | structure-break.html | multi‑TF structure |
| `/session-continuity` | session-continuity.html | session/multi‑TF |
| `/currency-continuity` | currency-continuity.html | multi‑TF |
| `/currency-state` | currency-state.html | multi‑TF state |
| `/currency-stability` | currency-stability.html | multi‑TF |
| `/daily-strength` | daily-strength.html | D1 |
| `/pullback-tri-engine`, `/pullback-tri-h4-engine` | …html | H4 pullback |
| `/currency-strength-m15`, `/m15-impulse`, `/m15-quality` | …html | M15‑native but pre‑intelligence engines |

## Consumers (do not break)
- Each legacy page fetches its own `/api/*` engine (e.g. `market-pressure.js`,
  `structure-break.js`, `currency-stability.js`, `daily-raw-strength.js`,
  `currency-strength-h1-ema*.js`, `pullback-tri-*.js`). These remain callable.
- **Shared data infrastructure is NOT legacy** and must stay: `cron-backtest-sync`
  (candle sync), `backtest-candles`, `run-pipeline`, `_db`, auth/profile — the M15
  intelligence system depends on the same `backtest_candles`.
- Active crons unchanged: `cron-backtest-sync` (hourly), `run-pipeline` (hourly).

## Reversible separation plan (owner action; not applied)
1. **Records of known provenance only.** For each legacy engine whose output table
   is known, add a nullable, defaulted, reversible column — additive:
   ```sql
   -- template 024 (per confirmed table): reversible, no data loss
   alter table <legacy_signal_table> add column if not exists strategy_generation text default 'LEGACY';
   -- DOWN: alter table <legacy_signal_table> drop column if exists strategy_generation;
   ```
   Do **not** guess tables — the owner confirms each table's provenance first. New
   M15‑intelligence rows live in `m15i_*` and are implicitly the current generation
   (no label needed), so there is no ambiguity to resolve retroactively.
2. **Label pages, keep URLs.** Add a lightweight "LEGACY — superseded by M15
   Intelligence" banner to each legacy page (a shared snippet), linking to `/app`.
   Bookmarks keep working; nothing is redirected or removed.
3. **Do not disable processing or delete** any legacy route, cron, table, or row in
   this phase. Separation is a *label*, reversible by dropping the column / banner.

## Explicitly out of scope this phase
Retiring routes, dropping tables, disabling the legacy crons, or removing pages —
all require separate owner approval **after** the M15 replacement is verified in
production (staging parity + scheduling, still open — see the handoff).
