-- ============================================================================
-- NervaFX — M15 Market Intelligence & Manual Trading Opportunity System
-- Migration 020 — ADDITIVE and REVERSIBLE (§3, §27, §34).
--
-- Creates the versioned analysis tables. Nothing here drops, alters or reads
-- existing tables; run it in the Supabase SQL editor. A matching DOWN section
-- (commented, at the bottom) reverses it. Historical M15 candles in
-- `backtest_candles` are untouched.
--
-- Every analytical row carries the reproducibility columns (§27):
--   analysis_time, source_candle_time, calculation_version, input_data_hash.
-- Given the same version + input hash, an engine must reproduce the same row.
-- ============================================================================

-- ── Strategy / configuration registry ───────────────────────────────────────
create table if not exists strategy_versions (
  id                 uuid primary key default gen_random_uuid(),
  version            text not null unique,      -- e.g. 'm15-cfg-1.0.0'
  config_hash        text not null,
  description        text,
  config_json        jsonb,
  created_at         timestamptz default now()
);

-- ── One row per completed-M15 run (§7 idempotency) ──────────────────────────
create table if not exists m15_analysis_runs (
  id                 uuid primary key default gen_random_uuid(),
  source_candle_time timestamptz not null,      -- the synchronized completed M15 close
  analysis_time      timestamptz not null default now(),
  calculation_version text not null,
  input_data_hash    text not null,
  idempotency_key    text not null unique,      -- (frame, version, inputs) — dupes rejected
  sync_state         text not null,             -- ALIGNED | MISALIGNED | MISSING_PAIRS
  pairs_processed    int  not null,
  notes              jsonb,
  created_at         timestamptz default now()
);
create index if not exists m15_runs_time_idx on m15_analysis_runs (source_candle_time desc);

-- Helper: shared columns comment for the per-record tables below.
-- (instrument|currency, analysis_time, source_candle_time, calculation_version,
--  input_data_hash, created_at)

-- ── Per-pair primary market state (§9) ──────────────────────────────────────
create table if not exists m15_pair_states (
  id                 uuid primary key default gen_random_uuid(),
  instrument         text not null,
  source_candle_time timestamptz not null,
  analysis_time      timestamptz not null default now(),
  previous_state     text,
  current_state      text not null,
  state_changed_at   timestamptz,
  state_duration_ms  bigint,
  change_evidence    jsonb,
  invalidation_evidence jsonb,
  structural_events  jsonb,
  calculation_version text not null,
  input_data_hash    text not null,
  created_at         timestamptz default now(),
  unique (instrument, source_candle_time, calculation_version)
);
create index if not exists m15_pair_states_idx on m15_pair_states (instrument, source_candle_time desc);

-- ── Adaptive structural events (§10) ────────────────────────────────────────
create table if not exists m15_structural_events (
  id                 uuid primary key default gen_random_uuid(),
  instrument         text not null,
  event_time         timestamptz not null,      -- the candle the event fired on
  source_candle_time timestamptz not null,      -- run frame it was detected in
  event_type         text not null,             -- UP_LEG_STARTED, DOWN_LEG_FAILED, ...
  price              numeric,
  threshold          numeric,
  meta               jsonb,
  calculation_version text not null,
  input_data_hash    text not null,
  created_at         timestamptz default now(),
  unique (instrument, event_time, event_type, calculation_version)
);
create index if not exists m15_struct_ev_idx on m15_structural_events (instrument, event_time desc);

-- ── Equilibrium / acceptance boundaries (§11) ───────────────────────────────
create table if not exists m15_equilibrium_zones (
  id                 uuid primary key default gen_random_uuid(),
  instrument         text not null,
  boundary_type      text not null default 'ACCEPTANCE',
  lower_price        numeric,
  upper_price        numeric,
  equilibrium_price  numeric,
  source_candle_time timestamptz not null,
  locked_at          timestamptz,
  invalidated_at     timestamptz,
  market_state       text,
  calculation_version text not null,
  input_data_hash    text,
  created_at         timestamptz default now()
);
create index if not exists m15_eq_idx on m15_equilibrium_zones (instrument, source_candle_time desc);

-- ── Analytical component tables (§12–§22) ───────────────────────────────────
-- Uniform shape: keyed by instrument or currency + source_candle_time + version.
do $$
declare
  t text;
  pair_tables text[] := array[
    'm15_pair_movement', 'm15_energy', 'm15_ema_states', 'm15_compression_states',
    'm15_pressure_states', 'm15_expansion_states', 'm15_agreement', 'm15_freshness'
  ];
  ccy_tables text[] := array[
    'm15_currency_movement', 'm15_currency_strength', 'm15_currency_power', 'm15_currency_structure'
  ];
begin
  foreach t in array pair_tables loop
    execute format($f$
      create table if not exists %I (
        id uuid primary key default gen_random_uuid(),
        instrument text not null,
        source_candle_time timestamptz not null,
        analysis_time timestamptz not null default now(),
        data jsonb not null,
        calculation_version text not null,
        input_data_hash text not null,
        created_at timestamptz default now(),
        unique (instrument, source_candle_time, calculation_version)
      );
      create index if not exists %I on %I (instrument, source_candle_time desc);
    $f$, t, t || '_idx', t);
  end loop;

  foreach t in array ccy_tables loop
    execute format($f$
      create table if not exists %I (
        id uuid primary key default gen_random_uuid(),
        currency text not null,
        source_candle_time timestamptz not null,
        analysis_time timestamptz not null default now(),
        data jsonb not null,
        calculation_version text not null,
        input_data_hash text not null,
        created_at timestamptz default now(),
        unique (currency, source_candle_time, calculation_version)
      );
      create index if not exists %I on %I (currency, source_candle_time desc);
    $f$, t, t || '_idx', t);
  end loop;
end $$;

-- ── Ranking, setups, manual signals (§24, §26) ──────────────────────────────
create table if not exists m15_pair_rankings (
  id uuid primary key default gen_random_uuid(),
  source_candle_time timestamptz not null,
  rank int not null,
  instrument text not null,
  score numeric,
  decision text,
  data jsonb,
  calculation_version text not null,
  input_data_hash text not null,
  created_at timestamptz default now(),
  unique (source_candle_time, instrument, calculation_version)
);
create index if not exists m15_rank_idx on m15_pair_rankings (source_candle_time desc, rank);

create table if not exists m15_setups (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  source_candle_time timestamptz not null,
  strategy text not null,
  direction text not null,
  trigger_price numeric,
  entry_zone_low numeric, entry_zone_high numeric,
  invalidation_price numeric,
  stop_price numeric, stop_pips numeric,
  target1 numeric, target2 numeric, rr numeric,
  freshness text, decision text,
  reasons jsonb,
  expires_at timestamptz, invalidated_at timestamptz,
  calculation_version text not null,
  input_data_hash text not null,
  created_at timestamptz default now(),
  unique (instrument, source_candle_time, calculation_version)
);
create index if not exists m15_setups_idx on m15_setups (instrument, source_candle_time desc);

-- Manual signals: created ONLY when a monitored trigger is reached (§24). This
-- system NEVER places a broker order; a row here is a notification, not a trade.
create table if not exists m15_manual_signals (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  setup_id uuid references m15_setups(id),
  signal_type text not null,                    -- MANUAL_BUY_OPPORTUNITY | MANUAL_SELL_OPPORTUNITY
  trigger_price numeric,
  triggered_at timestamptz not null default now(),
  spread_pips numeric,
  source_candle_time timestamptz not null,
  calculation_version text not null,
  created_at timestamptz default now()
);
create index if not exists m15_manual_idx on m15_manual_signals (instrument, triggered_at desc);

-- Seed the current strategy version (safe to re-run).
insert into strategy_versions (version, config_hash, description)
values ('m15-cfg-1.0.0', 'pending', 'Initial M15 intelligence config')
on conflict (version) do nothing;

-- ============================================================================
-- DOWN (reverse this migration) — run manually only if rolling back. Preserves
-- backtest_candles and all pre-existing tables.
-- ----------------------------------------------------------------------------
-- drop table if exists m15_manual_signals;
-- drop table if exists m15_setups;
-- drop table if exists m15_pair_rankings;
-- drop table if exists m15_pair_movement, m15_energy, m15_ema_states,
--   m15_compression_states, m15_pressure_states, m15_expansion_states,
--   m15_agreement, m15_freshness,
--   m15_currency_movement, m15_currency_strength, m15_currency_power,
--   m15_currency_structure;
-- drop table if exists m15_equilibrium_zones;
-- drop table if exists m15_structural_events;
-- drop table if exists m15_pair_states;
-- drop table if exists m15_analysis_runs;
-- drop table if exists strategy_versions;
-- ============================================================================
