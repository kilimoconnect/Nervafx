-- Phase 5: Market state detection

create table market_states (
  id uuid primary key default gen_random_uuid(),
  time timestamptz not null,
  instrument text not null,
  bias text not null,
  state text not null,
  confidence integer not null default 0,
  spread_3h numeric not null,
  spread_6h numeric not null,
  spread_12h numeric not null,
  spread_change_3h numeric,
  spread_change_6h numeric,
  spread_change_12h numeric,
  reason text,
  created_at timestamptz default now(),
  unique (time, instrument)
);

create index if not exists idx_market_states_time
  on market_states (time desc);
