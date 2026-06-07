-- M15 Energy Bars table
-- Stores lightweight 15-minute market energy scores for charting

CREATE TABLE IF NOT EXISTS m15_energy_bars (
  time_utc          TIMESTAMPTZ NOT NULL PRIMARY KEY,
  session_name      TEXT NOT NULL,
  market_energy     REAL NOT NULL DEFAULT 0,
  movement_score    REAL NOT NULL DEFAULT 0,
  breadth_score     REAL NOT NULL DEFAULT 0,
  agreement_score   REAL NOT NULL DEFAULT 0,
  dispersion_score  REAL NOT NULL DEFAULT 0,
  volatility_score  REAL NOT NULL DEFAULT 0
);

-- Index for time-range queries
CREATE INDEX IF NOT EXISTS idx_m15_energy_bars_time
  ON m15_energy_bars (time_utc DESC);

-- Enable RLS
ALTER TABLE m15_energy_bars ENABLE ROW LEVEL SECURITY;

-- Allow public read
CREATE POLICY "m15_energy_bars_read"
  ON m15_energy_bars FOR SELECT
  USING (true);
