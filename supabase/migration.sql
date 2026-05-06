-- Phase 1: Market candles and data quality tables

create table if not exists market_candles (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  timeframe text not null,
  time timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric,
  complete boolean not null default true,
  source text not null default 'OANDA',
  created_at timestamptz default now(),

  unique (instrument, timeframe, time)
);

create index if not exists idx_market_candles_instrument_time
  on market_candles (instrument, timeframe, time);

create table if not exists data_quality_checks (
  id uuid primary key default gen_random_uuid(),
  timeframe text not null,
  check_time timestamptz default now(),
  expected_candles integer not null,
  found_candles integer not null,
  missing_candles integer not null,
  status text not null,
  details jsonb,
  created_at timestamptz default now()
);
