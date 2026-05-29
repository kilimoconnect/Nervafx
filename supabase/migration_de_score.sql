-- Add de_score column to hourly_session_activity
-- Directional Efficiency: avg body/range ratio across all 28 pairs per hour (0-100)

ALTER TABLE hourly_session_activity
  ADD COLUMN IF NOT EXISTS de_score REAL DEFAULT 0;
