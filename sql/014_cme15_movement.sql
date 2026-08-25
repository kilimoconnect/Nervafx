-- NervaFX Currency Movement Engine — 15M twin persistence (isolated, additive).
-- Apply in the Supabase SQL editor. Idempotent (IF NOT EXISTS). Its OWN tables —
-- does NOT touch the H1 engine's cme_* tables or any currency-strength tables.
-- Primary timeframe M15, micro M5, BOS lookback 20. All timestamps UTC.

create table if not exists cme15_currency_movement_values (
  id                            bigserial primary key,
  engine_version                text not null default 'v1',
  configuration_version         text,
  evaluated_at                  timestamptz not null,
  window_name                   text not null,     -- M15 | M5 | REFERENCE_SESSION | ASIA_TO_DATE | LONDON_TO_DATE | DAY_TO_DATE
  currency                      text not null,     -- USD | EUR | GBP | JPY | CHF | CAD | AUD | NZD
  raw_movement                  double precision,
  movement_score                double precision,  -- signed, -100..+100
  state                         text,
  rank                          integer,           -- 1 = strongest
  breadth_h1                    double precision,  -- 15M breadth (primary tf)
  breadth_15m                   double precision,  -- M5 micro breadth
  breadth_combined              double precision,
  efficiency                    double precision,
  persistence                   double precision,
  acceleration                  double precision,
  micro_acceleration            double precision,
  micro_persistence             double precision,
  micro_breadth                 double precision,
  micro_state                   text,
  -- BOS structure layer (structure_15m_v1)
  structure_score               double precision,
  structure_direction           text,
  structure_classification      text,
  structure_breadth             double precision,
  confirmed_movement_score      double precision,
  structure_agreement           text,
  micro_structure_direction     text,
  micro_structure_score         double precision,
  metrics                       jsonb,
  created_at                    timestamptz not null default now(),
  unique (evaluated_at, window_name, currency, engine_version)
);

create index if not exists idx_cme15_eval_window on cme15_currency_movement_values (evaluated_at, window_name);
create index if not exists idx_cme15_currency on cme15_currency_movement_values (currency, window_name);

-- Pair-level Break of Structure (M15 primary).
create table if not exists cme15_pair_structure (
  id                    bigserial primary key,
  engine_version        text not null default 'v1',
  configuration_version text not null default 'structure_15m_v1',
  evaluated_at          timestamptz not null,
  pair                  text not null,
  base_currency         text,
  quote_currency        text,
  bos_direction         text,
  bos_type              text,
  previous_high         double precision,
  previous_low          double precision,
  broken_level          double precision,
  break_distance_price  double precision,
  break_distance_atr    double precision,
  close_quality         double precision,
  body_atr              double precision,
  atr20                 double precision,
  bos_strength_grade    text,
  decisive_break        boolean,
  pair_structure_score  double precision,
  pair_movement_edge    double precision,
  pair_confirmed_edge   double precision,
  structure_edge        double precision,
  structure_agreement   text,
  opportunity           text,
  metrics               jsonb,
  created_at            timestamptz not null default now(),
  unique (evaluated_at, pair, configuration_version)
);
create index if not exists idx_cme15_pair_struct_eval on cme15_pair_structure (evaluated_at);
create index if not exists idx_cme15_pair_struct_pair on cme15_pair_structure (pair);
