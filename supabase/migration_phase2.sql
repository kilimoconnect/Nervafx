-- Phase 2: Currency strength table

create table if not exists currency_strength (
  id uuid primary key default gen_random_uuid(),
  time timestamptz not null,
  currency text not null,

  raw_3h numeric not null default 0,
  raw_6h numeric not null default 0,
  raw_12h numeric not null default 0,

  normalized_3h numeric not null default 0,
  normalized_6h numeric not null default 0,
  normalized_12h numeric not null default 0,

  created_at timestamptz default now(),

  unique (time, currency)
);

create index if not exists idx_currency_strength_time
  on currency_strength (time desc);
