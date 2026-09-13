-- ============================================================================
-- ⚠ SUPERSEDED by sql/022_m15_intelligence.sql — DO NOT RUN.
-- 020's table names collided with a LEGACY table (`m15_currency_strength`, 32k+
-- rows), so 020 could not fully apply and this 021 depends on tables 020 never
-- created. 022 re-creates the whole intelligence schema under the collision-free
-- `m15i_` prefix. Run 022 instead; this file is kept only as history.
-- ============================================================================
-- NervaFX — Migration 021 — Phase 3 additions to the M15 intelligence schema.
--
-- 020 is ALREADY APPLIED, so its `create table if not exists` statements would
-- skip the existing tables and NEVER add new columns. This migration ALTERs the
-- existing tables instead. It is ADDITIVE, idempotent and re-runnable, and it
-- does NOT touch `backtest_candles` or any candle data. Run it in the Supabase
-- SQL editor AFTER 020. A DOWN section (commented) reverses it.
--
-- Adds: the snapshot state machine on m15_analysis_runs (status / close_time /
-- missing_pairs / error / retry_count / pairs_expected / updated_at) + a
-- (source_candle_time, calculation_version) unique index the writer upserts on;
-- gates/episode_key on m15_setups; row-level security on every M15 table; and the
-- real strategy-version hashes.
-- ============================================================================

-- ── m15_analysis_runs — snapshot state machine ──────────────────────────────
alter table m15_analysis_runs add column if not exists status        text not null default 'PENDING'; -- PENDING | COMPLETE | INCOMPLETE
alter table m15_analysis_runs add column if not exists close_time     timestamptz;                     -- exact UTC M15 close = source_candle_time + 15m
alter table m15_analysis_runs add column if not exists missing_pairs  jsonb;
alter table m15_analysis_runs add column if not exists error          text;
alter table m15_analysis_runs add column if not exists retry_count    int  not null default 0;
alter table m15_analysis_runs add column if not exists pairs_expected int  not null default 28;
alter table m15_analysis_runs add column if not exists updated_at     timestamptz default now();

-- backfill close_time for any pre-existing rows (frame open + 15 minutes)
update m15_analysis_runs set close_time = source_candle_time + interval '15 minutes' where close_time is null;

-- the writer upserts on (source_candle_time, calculation_version); a unique index
-- is idempotent and satisfies onConflict. (Fails only if duplicates already exist;
-- with the new writer unused yet, the table is empty or already unique.)
create unique index if not exists m15_runs_close_ver_uidx on m15_analysis_runs (source_candle_time, calculation_version);
create index if not exists m15_runs_status_idx on m15_analysis_runs (status, source_candle_time desc);

-- ── m15_setups — gate waterfall + episode identity ──────────────────────────
alter table m15_setups add column if not exists gates       jsonb;
alter table m15_setups add column if not exists episode_key text;
create index if not exists m15_setups_episode_idx on m15_setups (episode_key);

-- ── Row-level security (§34) — service writes, authenticated users read ──────
-- Was missing in 020. Mirrors backtest_candles. Drop-then-create is re-runnable.
do $$
declare t text;
  all_tables text[] := array[
    'strategy_versions','m15_analysis_runs','m15_pair_states','m15_structural_events',
    'm15_equilibrium_zones','m15_pair_movement','m15_energy','m15_ema_states',
    'm15_compression_states','m15_pressure_states','m15_expansion_states','m15_agreement',
    'm15_freshness','m15_currency_movement','m15_currency_strength','m15_currency_power',
    'm15_currency_structure','m15_pair_rankings','m15_setups','m15_manual_signals'
  ];
begin
  foreach t in array all_tables loop
    if to_regclass(t) is null then continue; end if;   -- skip a table that isn't present yet
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "service_full_access" on %I;', t);
    execute format($p$create policy "service_full_access" on %I for all using (true) with check (true);$p$, t);
    execute format('drop policy if exists "auth_read_only" on %I;', t);
    execute format($p$create policy "auth_read_only" on %I for select to authenticated using (true);$p$, t);
  end loop;
end $$;

-- ── Strategy-version hashes (020 seeded 1.0.0 with a placeholder) ────────────
update strategy_versions set config_hash = 'be69b3c4af041e9d', description = 'Phase 1 frozen baseline'
  where version = 'm15-cfg-1.0.0' and config_hash <> 'be69b3c4af041e9d';
insert into strategy_versions (version, config_hash, description)
  values ('m15-cfg-1.1.0a', '7c1a0ef93808702e', 'Phase 2 accepted — space is a per-trade test (correctness/safety)')
  on conflict (version) do nothing;

-- ============================================================================
-- DOWN (reverse 021 only; leaves 020's tables intact). Run manually to roll back.
-- ----------------------------------------------------------------------------
-- drop index if exists m15_setups_episode_idx;
-- alter table m15_setups drop column if exists gates, drop column if exists episode_key;
-- drop index if exists m15_runs_status_idx;
-- drop index if exists m15_runs_close_ver_uidx;
-- alter table m15_analysis_runs
--   drop column if exists status, drop column if exists close_time,
--   drop column if exists missing_pairs, drop column if exists error,
--   drop column if exists retry_count, drop column if exists pairs_expected,
--   drop column if exists updated_at;
-- delete from strategy_versions where version = 'm15-cfg-1.1.0a';
-- (RLS policies from this migration can be dropped per table if required.)
-- ============================================================================
