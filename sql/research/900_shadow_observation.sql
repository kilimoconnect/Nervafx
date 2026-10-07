-- ============================================================================
-- NervaFX M15 STRATEGY RESEARCH — Stage 6 prospective observation schema.
--
-- ⚠ STAGED FOR REVIEW — DO NOT APPLY IN THIS TASK. Additive and reversible;
-- research-namespaced (`research_*`) so it is fully isolated from production
-- (`m15i_*`, `backtest_candles`, strategy tables). Nothing here places or manages
-- an order. Since Stage 5 selected NO candidate, these tables would stay EMPTY
-- until (and unless) a future candidate qualifies under a NEW version and a
-- post-freeze shadow cohort is deliberately started.
-- ============================================================================

-- Post-freeze prospective observation log (one row per verified completed close
-- once a shadow cohort is active). Records timing so "was it realistically
-- actionable" can be judged; carries NO economics and NO fills.
create table if not exists research_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  version text not null,                         -- frozen strategy/config/data version being observed
  source_close_utc timestamptz not null,         -- verified completed M15 close (UTC)
  candle_available_at timestamptz,               -- when the candle data became available
  analysis_completed_at timestamptz,             -- when the research analysis finished
  displayed_notice_at timestamptz,               -- when an in-app notice was shown (if any)
  earliest_manual_decision_at timestamptz,       -- earliest practicable manual response time
  episode_id text,                               -- deduped episode id (null when no candidate)
  data_missing boolean not null default false,
  data_stale boolean not null default false,
  mode text not null default 'LIVE',             -- LIVE only; REPLAY/BACKFILL never write a live notice
  created_at timestamptz default now(),
  unique (source_close_utc, version)             -- dedup: one observation per close+version
);
create index if not exists research_shadow_runs_idx on research_shadow_runs (version, source_close_utc desc);

-- Optional authenticated manual journal — what the user actually saw/did OUTSIDE
-- the app. SELF-REPORTED; never mixed with simulated fills; never infers a fill;
-- one user's rows private to that user.
create table if not exists research_shadow_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  version text,
  episode_id text,
  source_close_utc timestamptz,
  action text not null,                          -- SEEN | SKIPPED | MANUALLY_TRADED
  self_reported jsonb,                           -- user's own times/prices/notes (labelled)
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, episode_id, action)
);
create index if not exists research_shadow_journal_user_idx on research_shadow_journal (user_id, created_at desc);

-- RLS: service writes; authenticated users read the shared observation log; the
-- journal is private per user.
alter table research_shadow_runs enable row level security;
drop policy if exists "svc" on research_shadow_runs;
create policy "svc" on research_shadow_runs for all using (true) with check (true);
drop policy if exists "auth_read" on research_shadow_runs;
create policy "auth_read" on research_shadow_runs for select to authenticated using (true);

alter table research_shadow_journal enable row level security;
drop policy if exists "svc" on research_shadow_journal;
create policy "svc" on research_shadow_journal for all using (true) with check (true);
drop policy if exists "owner_sel" on research_shadow_journal;
create policy "owner_sel" on research_shadow_journal for select to authenticated using (user_id = auth.uid());
drop policy if exists "owner_ins" on research_shadow_journal;
create policy "owner_ins" on research_shadow_journal for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "owner_upd" on research_shadow_journal;
create policy "owner_upd" on research_shadow_journal for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- DOWN (reverse):
-- drop table if exists research_shadow_journal;
-- drop table if exists research_shadow_runs;
-- ============================================================================
