# M15 Market Intelligence & Manual Trading Opportunity System

An M15‑only analytical and manual‑opportunity engine. It analyses **only completed
15‑minute candles** for the 8 majors and the standard 28 pairs, and it **never**
places, manages, or suggests automatic broker orders. All entries are manual; the
system only detects setups and, when a predetermined trigger is reached, raises a
`MANUAL_BUY_OPPORTUNITY` / `MANUAL_SELL_OPPORTUNITY` notification.

## Hard rules (enforced in code + tests)

- **M15 only.** `api/_m15/data.js#assertM15` throws on any other timeframe; every DB
  read pins `timeframe='M15'` and `complete=true`. There is no M1/M5/M30/H1/H4/D1
  analysis path, and live bid/ask is never converted into candles.
- **No look‑ahead.** Every engine is a pure left→right function of candles up to the
  evaluation time. Historical replay reconstructs exactly what was known then.
- **Adaptive, not candle‑count based (§6).** States derive from volatility‑adjusted,
  pair‑normalized, event‑driven measures and EWMA baselines — never "last N candles".
- **Reproducible (§27).** Each record carries `calculation_version` + `input_data_hash`;
  same version + same inputs ⇒ identical output. Config is frozen and versioned.
- **No automatic execution.** No order‑placement code path exists anywhere in `_m15`.

## Data coverage (audited 2026‑09‑13, read‑only)

| | |
|---|---|
| Table | `backtest_candles` (timeframe `M15`) |
| Instruments | 28 / 28 |
| M15 candles | 920,056 |
| Range | 2025‑05‑19 13:15 UTC → 2026‑09‑11 20:30 UTC (~16 months) |
| Per pair | ~32,850–32,862 |
| Tick volume | present | 
| Duplicates | none (UNIQUE constraint) |
| Completeness | ~99.8% |

## Module map (`api/_m15/`, pure/deterministic)

| File | § | Purpose |
|---|---|---|
| `config.js` | 31 | Versioned thresholds + `configHash`, frozen |
| `pairs.js` | 8 | 8 currencies, 28 pairs, pip size, min threshold |
| `math.js` | 34 | TR, EWMA baselines, EMA, ramps — deterministic |
| `data.js` | 7,32 | M15‑only guard, completed‑candle boundary, 28‑pair sync, hashing, idempotency, no‑lookahead fetch |
| `structure.js` | 10 | Adaptive directional‑change / structural events |
| `equilibrium.js` | 11 | Adaptive equilibrium, acceptance, frozen boundaries, EMA20/50 |

## Build status (tranche 1 of the §35 sequence — foundation)

Done: repo + DB inspection, M15 data audit, versioned config, M15‑only data layer,
adaptive structural‑event engine, equilibrium/acceptance engine, additive migration
`sql/020_m15_intelligence.sql`, and 26 passing unit tests (`tests/m15/`).

Pending tranches (in order): movement → strength → power/breadth → energy → EMA →
compression/pressure → expansion/freshness → agreement → strategy router → manual
triggers → ranking → coordinator + cron + replay route → legacy isolation → UI →
historical validation (§33).

## Running the tests

```bash
node --test tests/m15/config.test.js tests/m15/data.test.js tests/m15/structure.test.js tests/m15/equilibrium.test.js
```

## Migration

`sql/020_m15_intelligence.sql` is additive and reversible; run it in the Supabase SQL
editor. It creates the `strategy_versions` registry and the `m15_*` versioned tables
and touches nothing that already exists.
