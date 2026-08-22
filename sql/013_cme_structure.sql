-- NervaFX Currency Movement Engine — BOS structure layer (structure_v1).
-- ADDITIVE only: adds columns/tables, never drops or renames. Idempotent.
-- Existing cme_currency_movement_values (v1) records stay valid and readable.

-- Currency-level structure fields (additive columns).
alter table cme_currency_movement_values add column if not exists configuration_version   text;
alter table cme_currency_movement_values add column if not exists structure_score          double precision;
alter table cme_currency_movement_values add column if not exists structure_direction      text;
alter table cme_currency_movement_values add column if not exists structure_classification text;
alter table cme_currency_movement_values add column if not exists structure_breadth        double precision;
alter table cme_currency_movement_values add column if not exists confirmed_movement_score double precision;
alter table cme_currency_movement_values add column if not exists structure_agreement      text;
alter table cme_currency_movement_values add column if not exists micro_structure_direction text;
alter table cme_currency_movement_values add column if not exists micro_structure_score     double precision;

-- Pair-level Break of Structure (its own normalized table).
create table if not exists cme_pair_structure (
  id                    bigserial primary key,
  engine_version        text not null default 'v1',
  configuration_version text not null default 'structure_v1',
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
  micro_structure_direction text,
  micro_break_distance_atr  double precision,
  metrics               jsonb,
  created_at            timestamptz not null default now(),
  unique (evaluated_at, pair, configuration_version)
);
create index if not exists idx_cme_pair_struct_eval on cme_pair_structure (evaluated_at);
create index if not exists idx_cme_pair_struct_pair on cme_pair_structure (pair);
