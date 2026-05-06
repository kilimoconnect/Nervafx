-- Phase 6: Trade signals

create table trade_signals (
  id uuid primary key default gen_random_uuid(),
  time timestamptz not null,
  instrument text not null,
  signal text not null,
  direction text,
  confidence integer not null default 0,
  entry_type text,
  entry_price numeric,
  stop_loss numeric,
  take_profit numeric,
  risk_reward numeric,
  market_state text,
  reason text,
  created_at timestamptz default now(),
  unique (time, instrument)
);

create index if not exists idx_trade_signals_time
  on trade_signals (time desc);
