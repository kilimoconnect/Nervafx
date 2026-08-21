-- NervaFX Currency Movement Engine — persistence (isolated, additive).
-- Apply in the Supabase SQL editor. Idempotent (IF NOT EXISTS). Its OWN table —
-- does NOT modify any existing currency-strength tables. All timestamps UTC.

create table if not exists cme_currency_movement_values (
  id                            bigserial primary key,
  engine_version                text not null default 'v1',
  evaluated_at                  timestamptz not null,
  window_name                   text not null,     -- H1 | M15 | REFERENCE_SESSION | ASIA_TO_DATE | LONDON_TO_DATE | DAY_TO_DATE  ("window" is a reserved word)
  currency                      text not null,     -- USD | EUR | GBP | JPY | CHF | CAD | AUD | NZD
  raw_movement                  double precision,
  movement_score                double precision,  -- signed, -100..+100
  state                         text,
  rank                          integer,           -- 1 = strongest
  breadth_h1                    double precision,
  breadth_15m                   double precision,
  breadth_combined              double precision,
  efficiency                    double precision,
  persistence                   double precision,
  acceleration                  double precision,
  -- 15M layer (additive)
  movement_score_15m_component  double precision,
  micro_acceleration            double precision,
  micro_persistence             double precision,
  micro_breadth                 double precision,
  micro_state                   text,
  metrics                       jsonb,
  created_at                    timestamptz not null default now(),
  unique (evaluated_at, window_name, currency, engine_version)
);

create index if not exists idx_cme_eval_window on cme_currency_movement_values (evaluated_at, window_name);
create index if not exists idx_cme_currency on cme_currency_movement_values (currency, window_name);
