-- Single-row table storing the latest AI decision intelligence result.
-- The cron (src/narrativeEngine.js) always upserts to id = 1.
create table if not exists market_energy_narrative (
  id          smallint    primary key default 1,
  computed_at timestamptz not null default now(),
  result      jsonb       not null
);
