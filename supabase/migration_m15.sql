-- migration_m15.sql
-- M15 pair spreads table
--
-- Stores per-instrument M15 strength spreads, smoothed values, and state.
-- One row per (time, instrument) — upserted each hourly run.
--
-- Lookback columns:
--   *_45m   ← 3  closed M15 candles back (≡ H1's 3H spread)
--   *_90m   ← 6  closed M15 candles back (≡ H1's 6H spread)
--   *_180m  ← 12 closed M15 candles back (≡ H1's 12H spread)
--
-- spread_*  = raw normalised (base − quote) at lookback
-- smooth_*  = EMA-smoothed (prev_norm + current_norm) / 2 at lookback
-- state     = EXPANDING | COMPRESSING | REVERSING | FLAT | STEADY

create table if not exists m15_pair_spreads (
  id           uuid        primary key default gen_random_uuid(),
  time         timestamptz not null,
  instrument   text        not null,

  spread_45m   numeric,
  spread_90m   numeric,
  spread_180m  numeric,

  smooth_45m   numeric,
  smooth_90m   numeric,
  smooth_180m  numeric,

  state        text,

  created_at   timestamptz default now(),

  unique(time, instrument)
);

-- Efficient lookups by recency (most common query pattern)
create index if not exists m15_pair_spreads_time_idx        on m15_pair_spreads (time desc);
create index if not exists m15_pair_spreads_instrument_idx  on m15_pair_spreads (instrument);
create index if not exists m15_pair_spreads_state_idx       on m15_pair_spreads (state);
