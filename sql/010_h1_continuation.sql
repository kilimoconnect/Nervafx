-- NervaFX H1 Continuation Engine — persistence (Portion 6).
-- Apply in the Supabase SQL editor. Idempotent (IF NOT EXISTS).

-- Current active state per setup, keyed by the stable setup id
-- (pair:direction:reference-impulse-end).
create table if not exists h1_continuation_setups (
  setup_id       text primary key,
  pair           text not null,
  direction      text not null,
  state          text not null,
  setup_score    integer,
  grade          text,
  reference_end  timestamptz,
  payload        jsonb,
  updated_at     timestamptz not null default now()
);

-- Append-only transition history. Never deleted, so completed / invalidated /
-- expired setups keep their full trail.
create table if not exists h1_continuation_history (
  id         bigserial primary key,
  setup_id   text not null,
  pair       text not null,
  direction  text not null,
  state      text not null,
  reason     text,
  at         timestamptz not null default now()
);

create index if not exists idx_h1c_history_setup_at
  on h1_continuation_history (setup_id, at desc);

create index if not exists idx_h1c_setups_state
  on h1_continuation_setups (state);
