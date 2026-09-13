# Phase 5 — evidence-based release decision & operational hardening

M15-only, manual-only. **No broker/MT5/OANDA-account access, no orders, no order
management, no lot sizing** anywhere. This phase verified infrastructure against the
real applied schema and prepared a supervised-release path. It did **not** activate
scheduling, change credentials, apply production SQL, or authorize automated trading.

## Evidence check — what is actually deployed / approved
| Item | Reality (verified, not assumed) |
|---|---|
| Engine version | `m15-cfg-1.1.0a` (Phase 2 accepted) — live on `/api/m15-intelligence` |
| Migrations | `sql/022` + `sql/023` **APPLIED by owner** — all `m15i_*` tables exist |
| Snapshot rows | **0 rows in every `m15i_*` table** — the snapshot job has never run |
| Scheduler | `/api/m15-snapshot` wired to **no scheduler**; not activated |
| Forward cohort | **none** — `M15_SHADOW_START_ISO` unset; zero forward observations |
| Read route + UI | live (decision-first, EAT, disclosure contract) |

**Conclusion: schema is applied but the shadow has never run — there is NO forward
evidence to evaluate.** No results were invented.

## Infrastructure hardening (defects found & fixed by a reversible integrity test)
A reversible test (`scripts/m15/verify-snapshot.js`) ran the **real writer** against
the applied schema for the last weekday close, verified it, then **deleted its own
rows** (DB restored to 0). It surfaced and fixed **three real defects that would
have broken every snapshot**:
1. **Schema mismatch** — writer sent `analysis_time` to `m15i_pair_rankings`/`_setups`,
   which `022` never gave that column → every write failed. Fixed (omit it; other
   tables default it).
2. **Version-string inconsistency** — run/detail rows used the short `m15-cfg-1.1.0a`
   while notifications used the full `…+hash`. Unified to the full version.
3. **Complete-flip re-insert** — the PENDING→COMPLETE step used upsert and tripped
   the `idempotency_key` unique constraint. Changed to a plain UPDATE.
Also **weekend/gap handling**: `latestCompletedM15Ms` returns a calendar frame with
no data on weekends; the writer now **SKIPS** when the data's last completed candle
isn't that exact frame, so stale data can never be published as a fresh COMPLETE
snapshot.

**Post-fix verification (real applied schema, close 2026-09-11 20:30):**
`status=COMPLETE`, `pairsProcessed=28`, `close_time` set, **stored-vs-recompute
parity = 0 decision mismatches** (live == replay at the same close+version),
**idempotent** (2nd write left exactly 1 run row), notifications correct (0 at a
0-actionable close), **rows after cleanup = 0** (fully reversible). This converts the
Phase 3/4 "DB integration UNVERIFIED" to **VERIFIED**.

## 1. Forward-evidence report (denominators; all forward counts are zero)
Frozen engine `m15-cfg-1.1.0a+7c1a0ef9…`, observation start **unset** ⇒ window empty.

| Metric (forward, after observation start) | Count | Denominator / note |
|---|---|---|
| Completed M15 closes | **0** | no scheduled runs |
| Complete 28-pair snapshots | **0** | job never ran |
| Unique setup episodes | **0** | — |
| Correlated pair clusters | **0** | — |
| Notices available | **0** | — |
| User views / acknowledgments | **0** | — |
| Self-reported manual trades | **0** | journal unused |
| Simulated outcomes | **0** | — |

- **Reliability:** not measurable — no scheduled runs to publish on time, miss, or
  duplicate. The writer's integrity/idempotency/skip behaviour is verified above; a
  real reliability record needs the scheduler live.
- **Practical timing:** not measurable — no forward views. Close→snapshot lag,
  publication→first-view, remaining-R-when-seen, and the "looked good at close but
  not usable when seen = practical failure" rate all populate only after the cohort
  runs.
- **Outcome uncertainty:** no forward outcomes. The **historical backtest** (kept
  strictly separate, never merged) shows only ~6 defined-risk episodes over 2.5
  months under 1.1.0a, mostly AMBIGUOUS under honest mid-price/pre-spread labelling
  — far too few to establish an edge, and not forward evidence.

Anti-overfitting: Phase-4 acceptance criteria were fixed **before** any results; no
rule was changed during evaluation; the rejected `1.1.0` variant is disclosed. No
win rate is claimed (Bailey et al.).

## 2. Recommendation — **CONTINUE SHADOW**
Operations are now built and **verified in a controlled test**, but there are **zero
independent forward opportunities** and no evidence a human could act in time,
because the scheduler is not wired and no cohort has started. This is not STOP/FIX
(no unresolved defect remains after the fixes), not REVISIT ENGINE (no forward
defect observed), and not RELEASE (no forward evidence, owner approval pending).
Per Phase 5, **CONTINUE SHADOW is a valid completed result when evidence is
insufficient.**

## 3. Supervised-release checklist (owner-controlled — NOT performed)
Verified/testable now: no-lookahead (15 tests), **live/replay parity** (integrity
test), **complete-snapshot reconciliation** (integrity test), notification **dedup**
(tests), **stale/incomplete never Actionable** (freshness guard + UI + notify),
**auth & journal access control** (tests: client user_id ignored, unauth rejected),
version consistency (fixed), **operator pause** (env `M15_PAUSE=1` suppresses notices
+ Actionable without erasing history — tested), no execution path (grep-clean).

Release steps (each owner-approved):
1. Confirm `022`/`023` in production (done) and run one manual `POST /api/m15-snapshot`
   (CRON_SECRET) at a weekday close; verify a COMPLETE run + parity via
   `scripts/m15/verify-snapshot.js`.
2. Point the **existing external scheduler (cron-job.org, ~5-min, EAT)** at
   `/api/m15-snapshot`. **Cron delivery/concurrency:** Vercel cron is UTC, at-least-
   once (can miss or duplicate) and does not guarantee single concurrency — but this
   project uses the external scheduler, and the job's **bounded catch-up +
   idempotency (unique (source_candle_time, calculation_version)) + PENDING→COMPLETE
   flip** make missed, late, duplicate, and overlapping fires safe (verified).
3. Set `M15_SHADOW_START_ISO` to the agreed cohort start; ratify acceptance criteria.
4. Monitor via `GET /api/m15-status` (latest complete snapshot, data age, missing
   pairs, processing lag, last successful run, version).

Rollback (last safe M15 version):
- **Incident pause:** set `M15_PAUSE=1` (suppresses notices + Actionable, history
  intact); unset to resume.
- Unwire the scheduler entry; unset `M15_SHADOW_START_ISO`.
- The read route/UI keep working on recompute; `022`/`023` DOWN blocks drop only
  `m15i_*` (never legacy, never `backtest_candles`).
- Revert the deploy to the previous commit if needed.

## 4. Legacy separation — reversible plan, **not applied** (owner approval pending)
Inventory in [`docs/phase4/LEGACY_INVENTORY.md`](../phase4/LEGACY_INVENTORY.md).
Note: primary navigation is **already M15-first** — the legacy multi-TF pages
(`/market-pressure`, `/structure-break`, `/currency-state`, …) are reachable only by
direct URL, not from the toolbar, so bookmarks are preserved and nothing is in the
primary nav to move. When the owner accepts M15 as primary:
- add a reversible `strategy_generation text default 'LEGACY'` column to **named
  legacy output tables of confirmed provenance only** (template in the inventory;
  DOWN drops the column) — do not guess ambiguous tables;
- add a "LEGACY — superseded by M15 Intelligence" banner to those pages (URLs kept).
Do **not** stop legacy jobs, drop tables, or delete rows without separate approval.

## Actions performed vs awaiting owner approval
**Performed (local + reversible test):** hardened the snapshot writer (3 defect
fixes + weekend skip), added the operator pause switch, added the integrity test
(ran once against the applied schema and **fully reversed** it — DB back to 0 rows),
added tests (now 139/139), wrote this report.
**Awaiting owner approval:** wiring the scheduler, setting the cohort start, applying
any legacy-labeling migration, and any production release. No scheduling, credential,
or trading action was taken.

## Files changed / added
- `api/m15-snapshot.js` — 3 defect fixes (schema/version/flip) + weekend-skip guard + pause-gated notices; `writeOne` exported for the test.
- `api/_m15/notify.js` — `isPaused` + `applyOperatorPause`; `api/m15-intelligence.js` — pause disclosure.
- `scripts/m15/verify-snapshot.js` — **new** reversible integrity/parity/idempotency test.
- `tests/m15/forward_notify.test.js` — +2 pause tests (suite 139/139).
- `docs/phase5/PHASE5_RELEASE_DECISION.md` — this report.
