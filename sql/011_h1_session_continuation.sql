-- NervaFX H1 Continuation Engine — SESSION mode persistence.
-- Apply in the Supabase SQL editor. Additive, idempotent (IF NOT EXISTS).
-- Separate tables from the Generic engine (h1_continuation_*) so the two modes'
-- records can never collide. All timestamps UTC.

-- Current active state per session setup, keyed by the stable session setup id
-- (session_h1_continuation:pair:direction:referenceSessionEndUtc).
create table if not exists h1_session_setups (
  setup_id              text primary key,
  mode                  text not null default 'session_h1_continuation',
  pair                  text not null,
  direction             text not null,
  state                 text not null,
  score                 integer,
  grade                 text,
  reference_session_end timestamptz,
  payload               jsonb,
  updated_at            timestamptz not null default now()
);

-- Append-only session transition history (never deleted).
create table if not exists h1_session_history (
  id         bigserial primary key,
  setup_id   text not null,
  mode       text not null default 'session_h1_continuation',
  pair       text not null,
  direction  text not null,
  state      text not null,
  reason     text,
  at         timestamptz not null default now()
);

create index if not exists idx_h1s_history_setup_at on h1_session_history (setup_id, at desc);
create index if not exists idx_h1s_setups_state on h1_session_setups (state);
