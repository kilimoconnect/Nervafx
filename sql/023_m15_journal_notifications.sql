-- ============================================================================
-- NervaFX — Migration 023 — Phase 4 manual observation journal + in-app
-- notification ledger. ADDITIVE, idempotent, reversible. Requires 022 (m15i_*).
-- Touches no legacy table and no candle data. Apply after 022, in STAGING first;
-- production application is owner-controlled.
-- ============================================================================

-- ── In-app notification ledger (shared opportunity feed; dedup per episode) ──
-- A row records that a NEW, complete, current manual-review opportunity was
-- surfaced. It is a flag for manual review — never an instruction or an order.
create table if not exists m15i_notifications (
  id uuid primary key default gen_random_uuid(),
  episode_id text not null,
  pair text, direction text,
  kind text not null default 'MANUAL_REVIEW_OPPORTUNITY',
  engine_version text not null,
  source_candle_time timestamptz,
  close_time timestamptz,
  created_at timestamptz default now(),
  unique (episode_id, engine_version)               -- dedup by episode + version
);
create index if not exists m15i_notif_idx on m15i_notifications (created_at desc);

-- ── Manual observation journal (per-user, self-reported) ────────────────────
-- Lets an authenticated user mark a displayed setup seen / skipped / manually
-- traded OUTSIDE NervaFX. It never infers a fill, never alters the signal, never
-- places an order, and one user's rows are private to that user.
create table if not exists m15i_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                            -- Supabase auth user id
  episode_id text,
  pair text,
  source_candle_time timestamptz,
  engine_version text,
  action text not null,                             -- SEEN | SKIPPED | MANUALLY_TRADED
  skip_reason text,                                 -- already_moved | spread_too_large | insufficient_room | not_available
  self_reported jsonb,                              -- {entry_time, exit_time, entry_price, exit_price, cost, notes} — user's own
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, episode_id, action)              -- one SEEN/SKIP/TRADE mark per user+episode
);
create index if not exists m15i_journal_user_idx on m15i_journal (user_id, created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Notifications: service writes, authenticated users read the shared feed.
alter table m15i_notifications enable row level security;
drop policy if exists "service_full_access" on m15i_notifications;
create policy "service_full_access" on m15i_notifications for all using (true) with check (true);
drop policy if exists "auth_read_only" on m15i_notifications;
create policy "auth_read_only" on m15i_notifications for select to authenticated using (true);

-- Journal: a user may see/insert/update ONLY their own rows. (The API also uses
-- the service key and scopes every query to the verified user id — defence in
-- depth; these policies protect any direct authenticated access.)
alter table m15i_journal enable row level security;
drop policy if exists "service_full_access" on m15i_journal;
create policy "service_full_access" on m15i_journal for all using (true) with check (true);
drop policy if exists "journal_owner_select" on m15i_journal;
create policy "journal_owner_select" on m15i_journal for select to authenticated using (user_id = auth.uid());
drop policy if exists "journal_owner_write" on m15i_journal;
create policy "journal_owner_write" on m15i_journal for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "journal_owner_update" on m15i_journal;
create policy "journal_owner_update" on m15i_journal for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- DOWN (reverse 023):
-- drop table if exists m15i_journal;
-- drop table if exists m15i_notifications;
-- ============================================================================
