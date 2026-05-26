-- Add impulse detection columns to m15_pair_spreads
-- These were previously computed on-the-fly in the API but never stored
ALTER TABLE m15_pair_spreads ADD COLUMN IF NOT EXISTS impulse_score REAL DEFAULT 0;
ALTER TABLE m15_pair_spreads ADD COLUMN IF NOT EXISTS impulse_dir SMALLINT DEFAULT 0;
ALTER TABLE m15_pair_spreads ADD COLUMN IF NOT EXISTS velocity REAL DEFAULT 0;
ALTER TABLE m15_pair_spreads ADD COLUMN IF NOT EXISTS body_ratio REAL DEFAULT 0;
ALTER TABLE m15_pair_spreads ADD COLUMN IF NOT EXISTS consec_dir SMALLINT DEFAULT 0;
