-- Compact M15 per-currency strength archive.
-- One row per 15-minute timestamp; values = { "USD": smooth45, "EUR": ..., x8 }.
-- Written by the live M15 engine each cycle and backfilled from M15 candles
-- (scripts/backfill-m15-strength.js). Unlike m15_pair_spreads (28 rows per
-- timestamp), this stays small enough to query over a year.

CREATE TABLE IF NOT EXISTS m15_currency_strength (
  time   TIMESTAMPTZ PRIMARY KEY,
  values JSONB NOT NULL
);
