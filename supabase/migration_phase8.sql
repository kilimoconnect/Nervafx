-- Phase 8: Trade actions

create table trade_actions (
  id uuid primary key default gen_random_uuid(),
  risk_check_id uuid references risk_checks(id),
  signal_id uuid references trade_signals(id),
  time timestamptz not null,
  instrument text not null,
  action_type text not null,
  status text not null,
  direction text,
  entry_price numeric,
  stop_loss numeric,
  take_profit numeric,
  position_size numeric,
  message text,
  broker_order_id text,
  error_message text,
  created_at timestamptz default now()
);

create index if not exists idx_trade_actions_time
  on trade_actions (time desc);
