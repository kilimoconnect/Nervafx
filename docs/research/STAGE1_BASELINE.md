# M15 Strategy Research — Stage 1 handoff (data audit, baseline, replay contract)

A **separate, versioned research layer** (`research/m15/`, `scripts/research/`,
`tests/research/`, `docs/research/`). It does not touch `api/_m15/` decisions,
thresholds, routes, schema, market data, or UI. **No strategies were created.**
No production migration, job, push, or deploy — local, read-only work only.

## Verified data (measured from the DB — not the old numbers)
`scripts/research/audit-m15.js` loaded every completed M15 row per pair.

| Fact | Verified value |
|---|---|
| Reported end date `2026-09-25` | **CONFIRMED** — latest close **2026‑09‑25 20:30 UTC** |
| Pair coverage | **28 / 28**, every pair reaches the end date (**0 laggards**) |
| Total M15 rows | **946,934** (the old 920,056 is stale — not reused) |
| Earliest close | 2025‑05‑19 13:15 UTC |
| Rows / pair | 33,805 – 33,822 |
| Duplicates / incomplete / bad OHLC | **0 / 0 / 0** |
| Volume null / zero | 0 / 0 |
| Non‑OANDA source rows | 0 |
| Intraday missing candles | 5,448 total (~195/pair ≈ **0.58%** — thin‑liquidity/rollover gaps) |
| Range outliers (>10× median) | 533 total (~19/pair — news spikes; flagged, not removed) |
| Price type | **MID only** (OANDA `price=M`) — **no bid/ask, so no spread in the candle store** |
| Volume type | OANDA **tick/price-count** — explicitly **NOT** buyer/seller trading volume |
| Timestamps | `time` = candle **START** (UTC `timestamptz`); close = `time + 15m`; complete‑only ingested |
| Dedup | `UNIQUE(instrument,timeframe,time)` |
| Data snapshot hash | **`84405f31dc880be4`** (coverage fingerprint) |

Full per‑pair detail: `docs/research/data_audit.json`.

## Replay contract (traced & tested — no timing defect)
OANDA start stamps are preserved, so the eligibility rule is:

> A candle is eligible at evaluation close **T** iff `complete = true` **and**
> `open + 15m ≤ T` (equivalently `open ≤ T − 15m`).

**Boundary test (passing):** at `T = 2026‑09‑10 12:00 UTC` (15:00 EAT) the
14:45‑EAT (11:45‑UTC) candle **is** included (closes 12:00 ≤ T) and the 15:00‑EAT
(12:00‑UTC) candle **is excluded** (closes 12:15 > T). Every feature, cross‑pair
calc, chart, and simulated decision must consume the single **as‑of** view from
`syncAsOf`, which truncates all 28 pairs to their common latest frame (no pair sees
further than another) and reports `missing`/`laggards`. Weekend/closure/gap frames
resolve to an older common frame or are reported, never fabricated.

This matches the production Phase‑1 fix (verified independently here in the research
layer), so there is **no known look‑ahead** in the research replay.

## Baseline manifest
`docs/research/baseline_manifest.json` — git revision `c9d5409`, production engine
reference (`m15-cfg-1.0.0` `be69b3c4…`, accepted `m15-cfg-1.1.0a` `7c1a0ef9…` — for
reference; the research layer does not use them), data snapshot hash, verified date
range/coverage, price/volume/spread semantics, costs assumed (**none yet**), replay
cadence (full), episode definition (**N/A in Stage 1**), and test commands.

**Existing‑report status:** Phase‑1 **full‑cadence** replay was actually completed
(`docs/phase1`, ~7,008 closes / 196,224 pair‑evals, stride 1). The old
`docs/M15_VALIDATION.md` is an **every‑4th‑close hourly sample** — its ~10–13 fills
are **not** a full‑cadence baseline and **not** a basis to infer profitability.

## Research skeleton (`research/m15/loader.js`) — read‑only, offline
- `syncAsOf(historiesByPair, evaluationCloseUtc)` → `{ frameOpenMs, aligned, missing, laggards, bySync }` — the no‑lookahead as‑of view.
- `replay(histories, { fromCloseMs, toCloseMs, onClose, warmupCandles, startAtCloseMs })` — chronological, deterministic, **checkpointable** every‑close iterator (creates no strategies).
- `integrityReport(histories)` — coverage / duplicates / single‑source check.
- `loadAllPairsFromDb(sb, { fromIso, toIso })` — **SELECT‑only**, batched (1000‑row pages), chronological. Large jobs run offline (`scripts/research/`), never inside a Vercel request.

## Tests (`node --test tests/research/loader.test.js` → 9 pass / 0 fail)
No‑lookahead boundary (14:45 in / 15:00 out), UTC↔EAT, `frameOpenForClose`, missing
pair, laggard collapses common frame, determinism, source consistency, replay
chronology/no‑lookahead, and **loadAllPairsFromDb performs no writes** (a stub that
throws on insert/update/delete/upsert/rpc). Actual‑data audit: `node
scripts/research/audit-m15.js` (ran; results above).

## Blockers / notes for Stage 2
- **No spread in the candle store (mid‑only).** Any cost/slippage assumption in
  later stages must come from an external source and be stated explicitly; do not
  infer spread from mid candles.
- **Tick volume ≠ trading volume** — do not treat OANDA tick counts as buyer/seller
  flow.
- `@supabase/supabase-js` was installed **`--no-save`** locally so the offline audit
  could run; it is not added to `package.json`. Ensure `node_modules/` stays
  git‑ignored.
- Per Stage‑1 rules, nothing here is committed, pushed, or deployed.

## Actions performed vs pending
**Performed (local, read‑only):** measured the live DB, built the separate research
loader/replay skeleton + tests, wrote the baseline manifest and this handoff.
**Pending (Stage 2+):** strategy candidates, cost modelling, forward/holdout design.
None started. **Stop after Stage 1.**
