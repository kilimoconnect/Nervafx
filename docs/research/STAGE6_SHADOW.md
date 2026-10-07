# M15 Strategy Research — Stage 6 handoff (prospective shadow + research view)

**Precondition result:** Stage 5's accepted verdict is **NONE PASSED** — no candidate
was selected for shadow. Per the Stage 6 instruction, this delivers a **research-health
view and archived comparisons only**; **no actionable strategy is manufactured**, no
"best trade" rank is shown, and no prospective cohort is started. Production M15 signals
are isolated; research is a separate namespace. Nothing is applied, activated, deployed,
or published in this task.

- Tests: `node --test tests/research/*.test.js` → **51 pass / 0 fail** (loader 9, features 10, registry 9, outcomes 8, walk-forward 8, health 7).
- Modules: `research/m15/health.js` (health + operating checks + notify gate). View: `research/ui/strategy-research.html` (local, NOT published). Staged SQL: `sql/research/900_shadow_observation.sql` (NOT applied).

## What has / has NOT been observed live
- **Observed live: NOTHING.** There is no live shadow evidence. The snapshot scheduler
  is not activated; `research_shadow_runs` would be empty even if applied.
- **Historical simulation only** (Stage 4/5), explicitly labelled backtest — never
  presented as live.
- The research view's "Prospective shadow" section shows **0 live observations** and
  states the scheduler is not activated and there is no selected candidate to observe.

## Strategy Research view (local; requires auth when served)
`research/ui/strategy-research.html` renders three CLEARLY SEPARATED categories —
① Historical simulation (backtest), ② Prospective shadow (live, empty), ③ Manual
journal (self-reported, empty) — plus: latest verified M15 close (UTC **and** EAT),
28-pair completeness and **data-freshness (shows STALE)**, experiment versions, the
A/B/C… fold comparison with verdicts and reasons, the incremental A-ladder, rejected
candidates, and currency-strength / four pressure-horizon **descriptors** (explanations,
not signals). It shows a bold **NONE PASSED** state and **no "best trade" rank**.
Verified in a local preview (screenshot evidence): close 2026-09-25 23:45 EAT, **STALE ·
36h old**, 28/28 complete, 8 REJECT rows. It has **no order path** and sends no notices.

Reads `docs/research/stage5_scorecard.json` + `docs/research/research_health.json`
(built by `scripts/research/build-health.js`).

## Prospective observation manifest (versioned; nothing running)
- **Frozen version under observation:** _none_ (Stage 5 selected no candidate).
- **Log schema (staged, additive, not applied):** `research_shadow_runs` records per
  verified close — source close (UTC), candle-available time, analysis-completed time,
  displayed-notice time, episode id, data missing/stale, **earliest practicable manual
  decision time**, mode — with `unique(source_close_utc, version)` for dedup.
- **Notice gate (`shouldNotify`, tested):** a notice is permitted ONLY for a **LIVE,
  COMPLETE, non-stale, NEW** episode **with a selected candidate**. REPLAY and BACKFILL
  never notify; incomplete/stale/duplicate are blocked; with no candidate, nothing ever
  notifies.
- **Predeclared review (for a FUTURE cohort, if a candidate ever qualifies):** review
  only after **≥ 8 weeks** of live post-freeze observation **and ≥ 100 unique,
  correlation-deduped independent episodes**; a rule change **restarts** the cohort under
  a **new version**. Do not shorten or re-select on inspected history.

## Operational checklist (checks implemented + tested in `operatingChecks`)
- Late candle (arrived > threshold after close) → flagged.
- Scheduler retry / duplicate (same close+version) → deduped by unique key + `duplicateRun`.
- Incomplete 28-pair snapshot (< 28 present) → flagged; never shown as complete.
- Data gap (non-weekend missing interval) → flagged.
- Stale signal (data older than one interval + grace) → flagged; **never a current
  opportunity** (the view shows STALE).
- Version change → flagged ⇒ restart cohort under the new version.

## Files needing later owner review (NOT applied here)
- `sql/research/900_shadow_observation.sql` — apply in **staging** only when a shadow
  cohort is deliberately started (a candidate qualifies); reversible DOWN included.
- Activating the snapshot scheduler and publishing/auth-gating the research view are
  **owner-controlled** and out of scope for this task.

## Assessment — **CONTINUE OBSERVING**
No candidate passed Stage 5, so there is nothing to shadow and nothing to revise into a
new version from this data. The deliverable is the research-health view + archived
comparisons, which is complete and verified. **Recommendation: CONTINUE OBSERVING** — keep
accruing verified M15 history; only if a future analysis produces a candidate meeting the
Stage-5 standard should a **new-version, post-freeze shadow cohort** begin (apply the
staged schema, activate the scheduler under owner control). Not STOP (the pipeline and
data are healthy); not REVISE-AS-NEW-VERSION (no evidence yet justifies a new rule set).

## Acceptance — met
- **No historical replay mistaken for live:** backtest is explicitly labelled; prospective
  shadow shows 0 live; REPLAY/BACKFILL can never notify (tested).
- **No shadow signal can place an order:** no order path anywhere; read-only; no candidate.
- **Missing/stale data cannot appear as a current opportunity:** freshness/completeness are
  shown, STALE is flagged, and with no candidate no opportunity is ever surfaced.
