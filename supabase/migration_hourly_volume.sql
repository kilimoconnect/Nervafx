-- Add hourly_volume column to hourly_session_activity
-- Aggregated from M15 candle volumes (4 candles × 28 pairs per hour)

ALTER TABLE hourly_session_activity
  ADD COLUMN IF NOT EXISTS hourly_volume BIGINT DEFAULT 0;
