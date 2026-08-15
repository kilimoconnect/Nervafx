-- NervaFX Liquidity Failure Engine — persistence (Portion 2).
-- Apply in the Supabase SQL editor. Additive and idempotent (IF NOT EXISTS).
-- All timestamps are UTC (timestamptz). No RLS: accessed server-side with the
-- service key, matching backtest_candles / h1_continuation_* conventions.
-- Analytical only — nothing here executes or records broker orders.

-- ── Engine run log ───────────────────────────────────────────────────────────
create table if not exists liquidity_failure_engine_runs (
  id               bigserial primary key,
  evaluation_time  timestamptz not null,   -- snapped UTC evaluation time
  requested_time   timestamptz,            -- raw request (null when latest available)
  mode             text not null,          -- latest_available | historical
  config_version   text not null,
  pairs_requested  integer,
  pairs_evaluated  integer,
  data_errors      integer,
  coverage         jsonb,                  -- derived coverage snapshot
  created_at       timestamptz not null default now(),
  unique (evaluation_time, config_version)
);

-- ── H1 liquidity levels ──────────────────────────────────────────────────────
create table if not exists liquidity_failure_levels (
  id             bigserial primary key,
  pair           text not null,
  level_type     text not null,            -- SWING_HIGH | SWING_LOW | EQUAL_HIGHS | EQUAL_LOWS
  level_price    double precision not null,
  zone_low       double precision,
  zone_high      double precision,
  formed_at      timestamptz not null,     -- pivot candle OPEN, UTC
  h1_atr         double precision,
  config_version text not null,
  metrics        jsonb,
  created_at     timestamptz not null default now(),
  unique (pair, level_type, formed_at, config_version)
);
create index if not exists idx_lfe_levels_pair_formed
  on liquidity_failure_levels (pair, formed_at);

-- ── Attack → breakout → failure events ───────────────────────────────────────
create table if not exists liquidity_failure_events (
  id             bigserial primary key,
  event_key      text unique,              -- stable idempotency key (pair:dir:centre:setup:anchor:version)
  level_id       bigint references liquidity_failure_levels(id),
  pair           text not null,
  failed_side    text not null,            -- BUYERS | SELLERS
  direction      text not null,            -- BUY | SELL
  setup_type     text not null,            -- IMMEDIATE | DELAYED
  attack_at      timestamptz,
  breakout_at    timestamptz,
  failure_at     timestamptz not null,     -- H1 close of the failure, UTC
  config_version text not null,
  metrics        jsonb,
  created_at     timestamptz not null default now(),
  unique (pair, level_id, failure_at, setup_type, config_version)
);
create index if not exists idx_lfe_events_pair_failat
  on liquidity_failure_events (pair, failure_at);
create index if not exists idx_lfe_events_level
  on liquidity_failure_events (level_id);

-- ── M15 market-structure-shift confirmations ────────────────────────────────
create table if not exists liquidity_failure_confirmations (
  id             bigserial primary key,
  event_id       bigint references liquidity_failure_events(id),
  pair           text not null,
  confirmed_at   timestamptz not null,     -- M15 close that confirmed the shift, UTC
  mss_price      double precision,
  config_version text not null,
  metrics        jsonb,
  created_at     timestamptz not null default now(),
  unique (event_id, confirmed_at, config_version)
);
create index if not exists idx_lfe_conf_event
  on liquidity_failure_confirmations (event_id);

-- ── Signals (current state per setup, stable idempotency key) ────────────────
create table if not exists liquidity_failure_signals (
  signal_key     text primary key,         -- pair:direction:levelTime:failureTime
  pair           text not null,
  direction      text not null,            -- BUY | SELL
  setup_type     text not null,            -- IMMEDIATE | DELAYED
  classification text,                     -- TREND_ALIGNED | COUNTERTREND
  score          integer,
  state          text not null,            -- current (latest transition) state
  level_id       bigint references liquidity_failure_levels(id),
  event_id       bigint references liquidity_failure_events(id),
  first_seen_at  timestamptz not null,     -- evaluation time first observed, UTC
  updated_at     timestamptz not null default now(),
  config_version text not null,
  payload        jsonb
);
create index if not exists idx_lfe_signals_pair  on liquidity_failure_signals (pair);
create index if not exists idx_lfe_signals_state on liquidity_failure_signals (state);

-- ── Append-only state transitions ────────────────────────────────────────────
create table if not exists liquidity_failure_state_transitions (
  id              bigserial primary key,
  signal_key      text not null,
  from_state      text,
  to_state        text not null,
  reason          text,
  occurred_at     timestamptz not null,    -- event time driving the transition, UTC
  evaluation_time timestamptz not null,    -- when the engine observed it, UTC
  config_version  text not null,
  idempotency_key text not null unique,    -- signal_key|to_state|occurred_at
  created_at      timestamptz not null default now()
);
create index if not exists idx_lfe_trans_signal_occ
  on liquidity_failure_state_transitions (signal_key, occurred_at);

-- ── Outcomes (post-hoc analytical resolution; never overwrites replay state) ──
create table if not exists liquidity_failure_outcomes (
  id             bigserial primary key,
  signal_key     text not null,
  outcome        text,                     -- TARGET_REACHED | INVALIDATED | EXPIRED
  resolved_at    timestamptz,              -- UTC
  r_multiple     double precision,         -- analytical only, not execution
  config_version text not null,
  metrics        jsonb,
  created_at     timestamptz not null default now(),
  unique (signal_key, config_version)
);
