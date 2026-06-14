-- Add 4H and Daily (24H) currency strength columns
ALTER TABLE currency_strength
  ADD COLUMN IF NOT EXISTS raw_4h         numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS normalized_4h  numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS smooth_4h      numeric,
  ADD COLUMN IF NOT EXISTS raw_1d         numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS normalized_1d  numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS smooth_1d      numeric;
