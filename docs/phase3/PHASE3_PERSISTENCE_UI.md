# Phase 3 — durable M15 snapshots & decision-first UI

Analytical / manual-only. No migration applied, no production cron enabled, no
deploy, no push, no candle data deleted, no legacy routes retired. All engine
formulas/thresholds unchanged.

## Prerequisites checked
- **Phase 1 timing:** replay has no future-candle access; `tests/m15/lookahead.test.js`
  8/8 pass. Opportunity counts are unique episodes, not pair-at-close rows.
- **Phase 2 accepted version:** **`m15-cfg-1.1.0a`** (space is a per-trade test —
  correctness/safety; the signal-admitting `1.1.0` is rejected/shadow-test-only;
  baseline `1.0.0` kept as fallback). Documented in `docs/phase2/PHASE2_GATE_CALIBRATION.md`.
  This is the version Phase 3 publishes. Trading performance remains **unproven**.
- Full suite after Phase 3: **`node --test tests/m15/*.test.js` → 124 pass / 0 fail.**

## 1. Persistence — `sql/022` (m15i_ prefix) supersedes `020`/`021` (name collision)
**Critical finding on apply:** `020`'s table names collide with a **legacy table
`m15_currency_strength` (32,622 rows, different schema)**. `create table if not
exists` skipped it, then the `(currency, …)` index failed and aborted `020` mid-way
— so `m15_setups` and later tables were never created, and `021` then failed too.
Fix: **`sql/022_m15_intelligence.sql`** re-creates the entire intelligence schema
under the collision-free prefix **`m15i_`** (self-contained: state machine, RLS,
gates/episode columns, seed). It touches no legacy table and no candle data. Apply
**`022` only**; `020`/`021` are superseded (banners added). The snapshot writer and
docs now use `m15i_*`. Empty `m15_*` tables `020` half-created are harmless orphans
(optional, verified-empty drop listed in `022`'s footer — never `m15_currency_strength`).

### (historical) `sql/021` review notes
**`sql/020` is already applied**, so its `create table if not exists` statements
skip the existing tables and cannot add new columns — and applied migrations should
be immutable. So `020` is left exactly as applied, and the Phase-3 additions are a
new additive migration **`sql/021_m15_intelligence_phase3.sql`** that `ALTER`s the
existing tables (idempotent, re-runnable, `backtest_candles` untouched).

Review confirmed `020` already records reproducibility columns (`analysis_time,
source_candle_time, calculation_version, input_data_hash`), the `idempotency_key`
unique constraint, and 28-pair + 8-currency + gate + episode homes. **Gaps closed by
`021`:**
- **State machine** on `m15_analysis_runs`: `status` (PENDING|COMPLETE|INCOMPLETE),
  `close_time` (exact UTC M15 close = frame open + 15m; EAT = that at UTC+3;
  backfilled for existing rows), `missing_pairs`, `error`, `retry_count`,
  `pairs_expected`, `updated_at`, plus a **unique index** on
  `(source_candle_time, calculation_version)` the writer upserts on.
- **Row-level security** (was missing in `020`) on every M15 table — service role
  writes, authenticated users read — mirroring `backtest_candles`; drop-then-create
  policies so it re-runs.
- **`m15_setups`** gains `gates jsonb` (full waterfall) + `episode_key` (dedupe an
  armed run into one episode).
- Fixes the strategy-version hashes (`020` seeded `1.0.0` as `pending`) and adds
  `1.1.0a` (`7c1a0ef9…`).
- `021` has its own DOWN block reversing only its changes.

**Time convention:** `source_candle_time` is the FRAME OPEN (last candle closed by
the eval instant); `close_time` is the exact M15 close.

### Apply steps (owner action — NOT done here)
- **Staging:** in a staging project that already has `020`, paste
  `sql/021_m15_intelligence_phase3.sql`; confirm the new columns/index/policies
  exist and `backtest_candles` is untouched; run `POST /api/m15-snapshot` (with
  `CRON_SECRET`) and verify one `m15_analysis_runs` row flips PENDING→COMPLETE with
  28 pairs + rankings/currencies. If `020` is NOT yet on a target, apply `020` then
  `021`.
- **Production:** `020` is already applied — apply **`021`** once staging passes;
  reversible via its DOWN block. **No staging project was available to me, so
  database integration remains UNVERIFIED** — the pure job logic is tested but the
  DB writes are not exercised here.
- Pre-check before `021`: `select source_candle_time, calculation_version, count(*)
  from m15_analysis_runs group by 1,2 having count(*) > 1;` must return no rows (the
  new unique index requires it); with the new writer still unused the table is
  normally empty.

## 2. Post-close snapshot job
- **Pure planning/state** (`api/_m15/snapshot.js`, tested `tests/m15/snapshot.test.js`
  7/7): `plannedCloses` reconciles a **bounded catch-up window** (default 8 closes)
  using the no-lookahead `latestCompletedM15Ms`, skipping any close already COMPLETE
  — so a late or missed invocation catches up and an on-time one does nothing new.
  `snapshotStatus` marks COMPLETE only when all 28 pairs are on one ALIGNED frame
  with no missing pairs; otherwise INCOMPLETE. `snapshotKey` gives idempotency.
- **Endpoint** (`api/m15-snapshot.js`): server-side only, `CRON_SECRET`-protected
  (same as `run-pipeline`), credentials never client-side. Uses the **same
  coordinator** as live/replay at version 1.1.0a. Writes the run **PENDING**, fills
  per-pair states/rankings/setups + currency tables, then flips to **COMPLETE** —
  a reader never sees a partial 28-pair calc as complete. Missing pairs / errors /
  retry_count are recorded and the run marked INCOMPLETE. Idempotent under retries
  and overlap via `unique(source_candle_time, calculation_version)`; a repeat for
  the same close+version updates in place — no duplicate rows or notifications.
  **Never places an order.**
- **Correction policy:** if late verified candle data would change an already-
  published close, a re-run for that close+version overwrites its rows in place
  (same idempotency key) and stamps a new `updated_at`; the version string makes
  any formula change a *new* row set, never a silent edit of history.

## 3. Cron eligibility — resolved (owner uses the existing external scheduler)
Vercel Hobby cannot do a 15-minute schedule, and Vercel cron is UTC and may
miss/duplicate. **You already run an external scheduler (cron-job.org, every ~5 min,
Africa/Dar_es_Salaam = EAT)** that hits the CRON_SECRET-protected pipeline. Point it
(or add an entry) at `POST /api/m15-snapshot` — its bounded catch-up + idempotency
absorb the 5-min cadence, early/late fires, and duplicates. **No new Vercel cron is
added and none is enabled here.** No browser polling is used to simulate cron.

## 4. Read API contract — `GET /api/m15-intelligence` (verified against live data)
Still read-only; now publishes 1.1.0a and **discloses**:
```
source: "recompute"            // stored snapshots come from /api/m15-snapshot
engineVersion: "m15-cfg-1.1.0a+7c1a0ef93808702e"
evalIso   / closeIso           // frame open / EXACT UTC M15 close
historyMode, liveTriggerMonitoring   // replay never monitors live triggers
completeness: { pairsProcessed, pairsExpected:28, syncState, missing[], complete }
freshness: { ageSeconds, ageCandles, stale }
counts: { ACTIONABLE, DEVELOPING, BLOCKED, UNAVAILABLE }
scan[]: { …, category, availableRoomR, primaryReason }
ordersDisabled:true, analyticalManualOnly:true
```
Live invocation against production returned `complete:true`, `stale:true` (weekend
data), `counts {ACTIONABLE:0, DEVELOPING:1, BLOCKED:27}` — 0 actionable, honestly.

## 5. Decision-first UI (index.html M15 tab) — verified via stubbed preview
Preserves the NervaFX shell, login, Overview, Settings, Admin, Sign Out, `/app`,
`/m15-intelligence`. Redesign:
- **Status bar:** LIVE/REPLAY, exact M15 close in EAT, data age, missing-pair
  count, engine version, `ANALYTICAL · MANUAL ONLY`; a **STALE** banner when data
  is old (live only); a HISTORY-MODE banner in replay that states live triggers are
  disabled.
- **Four category cards with counts** — Actionable / Developing / Blocked /
  Unavailable — reconciling to 28 (or explicit Unavailable). Defaults to Actionable,
  falls to Developing when Actionable = 0. **"0 actionable" is shown as such**
  ("waiting is a position") — a blocked row is never labelled the #1 opportunity.
- **Compact list:** pair, direction arrow, strategy/stage, freshness, room in R
  (when a setup defines it), and the primary status/reason. Each row expands to a
  plain-language **failed-gate panel** (gate · FAIL · evidence). All 28 inspectable
  without an oversized table.
- **Pair detail overlay:** M15 candlestick chart with structure/EMA/setup lines,
  agreement components + reasons, and setup levels (trigger/invalidation/stop/
  targets) **only when the engine has a valid setup**, labelled "a plan, not an
  order".
- **Eight-currency drilldown** (collapsible) with a note explaining why `power
  BUILDING` and structure `EXHAUSTED` (and freshness `TRADEABLE` with `NO_AGREEMENT`)
  can coexist — separate measurements.
- **Replay:** EAT date/time picker + Prev/Next completed M15 close; at 2026-09-10
  15:00 EAT the frame's last candle is 14:45 (11:45 UTC) — the 15:00-opening candle
  is never shown (Phase 1 fix).
- **Desktop + mobile** verified (2×2 category grid on mobile); labels are textual,
  not colour-only.

## Verification results
- `tests/m15/*.test.js`: **124 pass / 0 fail** (adds snapshot 7 + Phase-2 space 7).
- Read API contract exercised against the real DB (disclosure fields, counts,
  categories, version 1.1.0a). UI screens exercised in a stubbed preview:
  actionable, blocked + expandable gate detail, **0-actionable**, stale/missing
  status, detail overlay (levels + chart), currency drilldown, and mobile.
- Category counts reconcile to 28 (26 present + 2 unavailable in the mock).
- No execution/order code path exists in any new file (grep-clean; read route and
  snapshot writer place nothing).

## Unresolved / owner action
- **DB integration UNVERIFIED** — no staging project available to me; `sql/020` is
  not applied, so `/api/m15-snapshot`'s writes and stored-vs-recompute parity are
  untested end-to-end. Apply in staging and run the endpoint to verify.
- **Not deployed / not pushed.** Owner applies the migration, points the existing
  cron at `/api/m15-snapshot`, and deploys.
- A cleaner interface and persisted history do **not** demonstrate profitability;
  the strategy remains unproven (Phase 2).

## Files changed / added
- `sql/022_m15_intelligence.sql` — **new**, the schema to apply: full intelligence tables under `m15i_` (collision-free), state machine, RLS, seed. **Run this one.**
- `sql/020_*` unchanged (already applied, broken by collision); `sql/021_*` marked SUPERSEDED — do not run.
- `api/m15-snapshot.js` — writes to `m15i_*` tables.
- `api/_m15/snapshot.js` — **new** pure job planning/state. `api/m15-snapshot.js` — **new** secured writer endpoint.
- `api/m15-intelligence.js` — publish 1.1.0a + disclosure contract + categories (read-only).
- `api/_m15/coordinator.js` — version string reflects the actual config (baseline string unchanged).
- `public/index.html` — decision-first M15 tab (markup, CSS, script).
- `tests/m15/snapshot.test.js` — **new** (7). Full suite 124/124.
- `docs/phase3/PHASE3_PERSISTENCE_UI.md` — this report.
