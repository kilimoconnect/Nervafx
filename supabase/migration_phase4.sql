-- Phase 4: Pair strength spreads

create table pair_strength_spreads (
  id uuid primary key default gen_random_uuid(),
  time timestamptz not null,
  instrument text not null,
  base_currency text not null,
  quote_currency text not null,
  spread_3h numeric not null default 0,
  spread_6h numeric not null default 0,
  spread_12h numeric not null default 0,
  created_at timestamptz default now(),
  unique (time, instrument)
);

create index if not exists idx_pair_spreads_time
  on pair_strength_spreads (time desc);
