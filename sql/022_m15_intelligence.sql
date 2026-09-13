-- ============================================================================
-- NervaFX — Migration 022 — M15 Intelligence schema under the collision-free
-- prefix `m15i_`. SUPERSEDES 020 + 021.
--
-- WHY: 020 reused names that already exist as LEGACY tables — notably
-- `m15_currency_strength` (32k+ rows, different schema). `create table if not
-- exists` then skips them and the follow-on index/`currency` column fails, which
-- aborted 020 mid-way. Renaming the NEW tables (not the legacy ones) removes the
-- collision entirely and touches no existing data.
--
-- ADDITIVE, idempotent, reversible. Does NOT drop, alter or read any legacy table
-- or `backtest_candles`. The empty `m15_*` intelligence tables that 020 partially
-- created are left as harmless orphans (optional drop at the bottom — verify they
-- are empty first). Run this whole file in the Supabase SQL editor.
-- ============================================================================

-- ── Strategy / configuration registry (no prefix — no collision) ────────────
create table if not exists strategy_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  config_hash text not null,
  description text,
  config_json jsonb,
  created_at timestamptz default now()
);

-- ── One row per completed-M15 run — with the Phase-3 state machine built in ──
create table if not exists m15i_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  source_candle_time timestamptz not null,      -- frame open (last candle closed by eval)
  close_time timestamptz,                        -- exact UTC M15 close = source_candle_time + 15m
  analysis_time timestamptz not null default now(),
  calculation_version text not null,
  input_data_hash text not null,
  idempotency_key text not null unique,
  status text not null default 'PENDING',        -- PENDING | COMPLETE | INCOMPLETE
  sync_state text not null,
  pairs_processed int not null default 0,
  pairs_expected int not null default 28,
  missing_pairs jsonb,
  error text,
  retry_count int not null default 0,
  notes jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (source_candle_time, calculation_version)
);
create index if not exists m15i_runs_time_idx on m15i_analysis_runs (source_candle_time desc);
create index if not exists m15i_runs_status_idx on m15i_analysis_runs (status, source_candle_time desc);

create table if not exists m15i_pair_states (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  source_candle_time timestamptz not null,
  analysis_time timestamptz not null default now(),
  previous_state text, current_state text not null,
  state_changed_at timestamptz, state_duration_ms bigint,
  change_evidence jsonb, invalidation_evidence jsonb, structural_events jsonb,
  calculation_version text not null, input_data_hash text not null,
  created_at timestamptz default now(),
  unique (instrument, source_candle_time, calculation_version)
);
create index if not exists m15i_pair_states_idx on m15i_pair_states (instrument, source_candle_time desc);

create table if not exists m15i_structural_events (
  id uuid primary key default gen_random_uuid(),
  instrument text not null, event_time timestamptz not null, source_candle_time timestamptz not null,
  event_type text not null, price numeric, threshold numeric, meta jsonb,
  calculation_version text not null, input_data_hash text not null, created_at timestamptz default now(),
  unique (instrument, event_time, event_type, calculation_version)
);
create index if not exists m15i_struct_ev_idx on m15i_structural_events (instrument, event_time desc);

create table if not exists m15i_equilibrium_zones (
  id uuid primary key default gen_random_uuid(),
  instrument text not null, boundary_type text not null default 'ACCEPTANCE',
  lower_price numeric, upper_price numeric, equilibrium_price numeric,
  source_candle_time timestamptz not null, locked_at timestamptz, invalidated_at timestamptz,
  market_state text, calculation_version text not null, input_data_hash text, created_at timestamptz default now()
);
create index if not exists m15i_eq_idx on m15i_equilibrium_zones (instrument, source_candle_time desc);

-- ── Uniform component tables (instrument- or currency-keyed) ────────────────
do $$
declare t text;
  pair_tables text[] := array['m15i_pair_movement','m15i_energy','m15i_ema_states','m15i_compression_states','m15i_pressure_states','m15i_expansion_states','m15i_agreement','m15i_freshness'];
  ccy_tables text[]  := array['m15i_currency_movement','m15i_currency_strength','m15i_currency_power','m15i_currency_structure'];
begin
  foreach t in array pair_tables loop
    execute format($f$
      create table if not exists %I (
        id uuid primary key default gen_random_uuid(),
        instrument text not null, source_candle_time timestamptz not null,
        analysis_time timestamptz not null default now(), data jsonb not null,
        calculation_version text not null, input_data_hash text not null, created_at timestamptz default now(),
        unique (instrument, source_candle_time, calculation_version));
      create index if not exists %I on %I (instrument, source_candle_time desc);$f$, t, t||'_idx', t);
  end loop;
  foreach t in array ccy_tables loop
    execute format($f$
      create table if not exists %I (
        id uuid primary key default gen_random_uuid(),
        currency text not null, source_candle_time timestamptz not null,
        analysis_time timestamptz not null default now(), data jsonb not null,
        calculation_version text not null, input_data_hash text not null, created_at timestamptz default now(),
        unique (currency, source_candle_time, calculation_version));
      create index if not exists %I on %I (currency, source_candle_time desc);$f$, t, t||'_idx', t);
  end loop;
end $$;

-- ── Ranking, setups, manual signals ─────────────────────────────────────────
create table if not exists m15i_pair_rankings (
  id uuid primary key default gen_random_uuid(),
  source_candle_time timestamptz not null, rank int not null, instrument text not null,
  score numeric, decision text, data jsonb,
  calculation_version text not null, input_data_hash text not null, created_at timestamptz default now(),
  unique (source_candle_time, instrument, calculation_version)
);
create index if not exists m15i_rank_idx on m15i_pair_rankings (source_candle_time desc, rank);

create table if not exists m15i_setups (
  id uuid primary key default gen_random_uuid(),
  instrument text not null, source_candle_time timestamptz not null,
  strategy text not null, direction text not null,
  trigger_price numeric, entry_zone_low numeric, entry_zone_high numeric,
  invalidation_price numeric, stop_price numeric, stop_pips numeric,
  target1 numeric, target2 numeric, rr numeric, freshness text, decision text,
  reasons jsonb, gates jsonb, episode_key text,
  expires_at timestamptz, invalidated_at timestamptz,
  calculation_version text not null, input_data_hash text not null, created_at timestamptz default now(),
  unique (instrument, source_candle_time, calculation_version)
);
create index if not exists m15i_setups_idx on m15i_setups (instrument, source_candle_time desc);
create index if not exists m15i_setups_episode_idx on m15i_setups (episode_key);

create table if not exists m15i_manual_signals (
  id uuid primary key default gen_random_uuid(),
  instrument text not null, setup_id uuid references m15i_setups(id),
  signal_type text not null, trigger_price numeric, triggered_at timestamptz not null default now(),
  spread_pips numeric, source_candle_time timestamptz not null, calculation_version text not null, created_at timestamptz default now()
);
create index if not exists m15i_manual_idx on m15i_manual_signals (instrument, triggered_at desc);

-- ── Row-level security — service writes, authenticated users read ────────────
do $$
declare t text;
  all_tables text[] := array['strategy_versions','m15i_analysis_runs','m15i_pair_states','m15i_structural_events','m15i_equilibrium_zones','m15i_pair_movement','m15i_energy','m15i_ema_states','m15i_compression_states','m15i_pressure_states','m15i_expansion_states','m15i_agreement','m15i_freshness','m15i_currency_movement','m15i_currency_strength','m15i_currency_power','m15i_currency_structure','m15i_pair_rankings','m15i_setups','m15i_manual_signals'];
begin
  foreach t in array all_tables loop
    if to_regclass(t) is null then continue; end if;
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "service_full_access" on %I;', t);
    execute format($p$create policy "service_full_access" on %I for all using (true) with check (true);$p$, t);
    execute format('drop policy if exists "auth_read_only" on %I;', t);
    execute format($p$create policy "auth_read_only" on %I for select to authenticated using (true);$p$, t);
  end loop;
end $$;

-- ── Seed strategy versions (real hashes) ────────────────────────────────────
insert into strategy_versions (version, config_hash, description) values
  ('m15-cfg-1.0.0',  'be69b3c4af041e9d', 'Phase 1 frozen baseline'),
  ('m15-cfg-1.1.0a', '7c1a0ef93808702e', 'Phase 2 accepted — space is a per-trade test (correctness/safety)')
on conflict (version) do update set config_hash = excluded.config_hash, description = excluded.description;

-- ============================================================================
-- DOWN (reverse 022). Drops ONLY the m15i_* intelligence tables — never a legacy
-- m15_* table and never backtest_candles.
-- ----------------------------------------------------------------------------
-- drop table if exists m15i_manual_signals, m15i_setups, m15i_pair_rankings,
--   m15i_pair_movement, m15i_energy, m15i_ema_states, m15i_compression_states,
--   m15i_pressure_states, m15i_expansion_states, m15i_agreement, m15i_freshness,
--   m15i_currency_movement, m15i_currency_strength, m15i_currency_power,
--   m15i_currency_structure, m15i_equilibrium_zones, m15i_structural_events,
--   m15i_pair_states, m15i_analysis_runs;
-- (strategy_versions is shared/harmless; drop only if you are sure nothing else uses it.)
--
-- OPTIONAL cleanup of the empty tables 020 partially created (VERIFY EMPTY FIRST,
-- and do NOT include m15_currency_strength — that one is legacy with real data):
--   select 'm15_analysis_runs' t, count(*) from m15_analysis_runs
--   union all select 'm15_setups', count(*) from m15_setups;   -- expect 0
-- then, only if 0:
--   drop table if exists m15_manual_signals, m15_setups, m15_pair_rankings,
--     m15_agreement, m15_freshness, m15_expansion_states, m15_pressure_states,
--     m15_compression_states, m15_ema_states, m15_energy, m15_pair_movement,
--     m15_equilibrium_zones, m15_structural_events, m15_pair_states, m15_analysis_runs;
-- ============================================================================
