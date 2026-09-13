# Phase 4 — Manual-only shadow rollout & prospective evaluation (handoff)

Analytical / manual-only. **No broker/MT5, no orders, no order management, no lot
sizing** anywhere. This phase built the shadow-observation machinery locally and
staging-ready; it did **not** apply production SQL, activate scheduling, push,
deploy, send external notifications, or delete legacy data.

## Preconditions (the gate)
| Precondition | Status |
|---|---|
| P1 replay / no-lookahead | ✅ resolved — 15/15 timing tests |
| P2 accepted engine version | ✅ `m15-cfg-1.1.0a` (+`7c1a0ef9…`) |
| P3 **staging snapshot parity** | ⛔ **UNRESOLVED** — `sql/022` not applied to any DB I can reach; no staging project; the writer's real DB writes + stored-vs-recompute parity are unexercised |
| Required **scheduling capability** | ⛔ **UNRESOLVED** — `/api/m15-snapshot` wired to no scheduler; production scheduling is owner-controlled and not activated |

**Therefore Phase 4 is NOT live and there is NO real forward cohort yet.** The two
open items are owner actions (apply `022`/`023` to staging, then wire the existing
cron-job.org at `/api/m15-snapshot`). Everything below is verified where it is
DB-independent and staging-ready otherwise.

## 1. Frozen forward observation (`api/_m15/forward.js`)
Pinned before any forward result exists: engine `m15-cfg-1.1.0a`, data source
(OANDA fxpractice · `backtest_candles` · M15 · MID), the **28-pair** universe, and
the **actionable definition** (ARMED/opportunity with a valid setup, all gates
passed, on a COMPLETE non-stale live snapshot). `observationStartMs` is **null
until the owner sets `M15_SHADOW_START_ISO`** — forward evidence counts only
episodes at/after it. **Stable `episodeId`** (pair·direction·first-armed-close·
version) makes repeated ARMED candles ONE opportunity. **Correlation grouping**
(`tagIndependence`) flags episodes that overlap in time and share a currency so
correlated pairs are not counted as independent evidence. Changing any frozen
field requires a **new version and a new cohort** — no mid-test edits.

## 2. Usability + operational status
- **Notifications** (`api/_m15/notify.js`, wired in `api/m15-snapshot.js`): a NEW
  in-app flag is emitted only on a **LIVE, COMPLETE, non-stale** snapshot, only for
  ACTIONABLE episodes, **deduped by episode+version** (unique
  `(episode_id, engine_version)`), never on replay, never re-announcing stale.
  In-app only — **no email/push** added. A notification is a manual-review flag,
  never an instruction or order.
- **Operational status** (`GET /api/m15-status`): latest COMPLETE snapshot, data
  age, missing pairs, processing lag (`analysis_time − close_time`), last
  successful run, engine version. Returns `status:UNVERIFIED` (not an error) until
  `022` is applied. The decision-first UI already suppresses stale/incomplete from
  Actionable (Phase 3).
- Snapshot rows already carry close (UTC), close_time (→ EAT), analysis_time
  (analysis complete), status, missing pairs — the timeline needed to judge whether
  an opportunity was actually usable.

## 3. Manual observation journal (`/api/m15-journal`, `sql/023`)
Authenticated users may mark a setup **SEEN / SKIPPED / MANUALLY_TRADED** (skip
reasons: already_moved, spread_too_large, insufficient_room, not_available), and
may voluntarily record their **own** times/prices/costs/notes on a manual trade —
stored **`_selfReported: true`**. Every query is scoped to the verified Supabase
user id; **client-supplied `user_id` is ignored** and RLS restricts direct access
to `user_id = auth.uid()`. The journal never infers a fill, never alters a signal,
never places an order, and never exposes one user's rows to another. `sql/023` is
additive and staging-tested-only.

## 4. Evaluation — sample report (BACKTEST cohort; forward/journaled empty)
Categories are kept strictly separate and never merged into one win rate:

| Cohort | Status |
|---|---|
| **Historical backtest** (m15-cfg-1.1.0a) | populated — reference only |
| **Forward shadow** | **EMPTY** — no cohort until `M15_SHADOW_START_ISO` + scheduling |
| **User-reported manual trades** | **EMPTY** — journal unused until 023 applied |

**Backtest denominators** (published 1.1.0a, 2026‑07‑01→09‑11, full cadence,
`docs/phase2` + `docs/phase1`): M15 closes **7,008** · pair‑at‑close decisions
**196,224** · **unique setup episodes 6** (baseline 1.0.0 had 36; 1.1.0a removes
30 undefined‑risk/thin‑room setups) · independent (correlation‑deduped) ≤ 6.
Outcome estimates are **mid‑price, pre‑spread, small‑n, and marked AMBIGUOUS** when
M15 cannot order stop vs target — **no win rate is claimed**.

**Operational usability metrics** (close→usable snapshot, publication→first human
view, setup age & remaining space when seen, fraction extended/invalidated/
untradeable, "looked good at close but not usable when seen = practical failure")
are **only measurable on the forward cohort** — they need real snapshot/publish/
view timestamps. They are **N/A for the backtest** and will populate once the
forward run and journal are live. This is stated, not faked.

## Predefined operational acceptance criteria (owner to ratify BEFORE forward review)
Set these *before* looking at forward results (anti-overfitting, Bailey et al.):
- **Operational:** ≥ 95% of completed M15 closes produce a COMPLETE snapshot within
  a target lag (e.g. ≤ 90s from close); missed/duplicate scheduler fires cause no
  gaps or duplicate notifications; 0 stale/incomplete rows ever shown as Actionable.
- **Evidence sufficiency:** a minimum count of **independent** (correlation‑deduped)
  forward episodes before any performance read (e.g. ≥ 30) — below that, report
  **insufficient evidence** and keep observing; do **not** loosen rules.
- **Usability:** median setup still valid with ≥ 1R room at realistic first view;
  practical‑failure rate below an agreed ceiling.
- Any rule change ⇒ new version + new forward cohort; never re‑pick from the same
  history.

## Owner-controlled release & rollback checklist
Release (each step owner-approved):
1. Apply **`sql/022`** (m15i_ schema) in **staging**; verify tables + RLS; run
   `POST /api/m15-snapshot` (CRON_SECRET) → one run flips PENDING→COMPLETE, 28 pairs.
2. Verify **stored-vs-recompute parity**: `GET /api/m15-intelligence?at=<close>`
   equals the stored snapshot for the same close+version.
3. Apply **`sql/023`** (journal + notifications) in staging; test journal access
   control (a user cannot read another's rows) and notification dedup.
4. Point the **existing cron-job.org** entry (5-min, EAT) at `/api/m15-snapshot`
   (staging URL). Confirm catch-up + idempotency across missed/duplicate fires.
5. Set **`M15_SHADOW_START_ISO`** to the agreed cohort start.
6. Repeat 1–4 in **production** only after staging passes and criteria are ratified.

Rollback: unwire the cron entry; `022`/`023` DOWN blocks drop only `m15i_*`
(never legacy, never `backtest_candles`); unset `M15_SHADOW_START_ISO`. The read
route/UI keep working on recompute.

## Legacy separation
Inventory + reversible `strategy_generation=LEGACY` plan in
[`docs/phase4/LEGACY_INVENTORY.md`](LEGACY_INVENTORY.md). Nothing disabled or
deleted; URLs preserved; label only, owner-controlled.

## Tests (137 pass / 0 fail — `node --test tests/m15/*.test.js`)
Phase-4 additions: stable episode id + version sensitivity; correlation
independence; forward window closed until owner-set; notifiable gate; **replay /
incomplete / stale never emit**; notification **dedup**; journal **access control**
(client user_id ignored, unauth rejected), action/skip validation, self-reported
labelling, SEEN never fabricates a fill. Plus existing timing/snapshot/no-execution
tests. A repo grep confirms **no order/execution path** in any new file.

## Recommendation
**CONTINUE OBSERVING — insufficient evidence; NOT go-live.** Reasons: (a) staging
snapshot parity and scheduling are unresolved (owner actions), so no real forward
cohort exists; (b) the backtest shows only ~6 defined-risk episodes over 2.5 months
— far too few to establish an edge, and mostly ambiguous under honest labelling.
Apply `022`/`023` in staging, wire the cron, ratify the criteria, set the cohort
start, and accumulate **independent** forward episodes before any performance read.
A cleaner UI and persisted history do **not** demonstrate profitability, and none
is claimed.

## Files added / changed
- `api/_m15/forward.js`, `api/_m15/notify.js`, `api/_m15/journal.js` — **new** pure modules.
- `api/m15-journal.js`, `api/m15-status.js` — **new** endpoints (auth, per-user, read-only status).
- `api/m15-snapshot.js` — notification persistence (dedup, oldest-first, episode carry-forward).
- `sql/023_m15_journal_notifications.sql` — **new** additive (journal + notifications + RLS).
- `tests/m15/forward_notify.test.js`, `tests/m15/journal.test.js` — **new** (13 tests).
- `docs/phase4/PHASE4_SHADOW_ROLLOUT.md`, `docs/phase4/LEGACY_INVENTORY.md` — this handoff.
