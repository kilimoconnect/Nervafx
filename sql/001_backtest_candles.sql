-- ============================================================================
-- NervaFX — Historical candle storage for backtesting engine
-- Run this in the Supabase SQL Editor before running the backfill script.
-- ============================================================================

-- Dedicated table for historical backtest candles (H1 + M15).
-- Separate from market_candles to keep the live pipeline fast and
-- allow independent retention / partitioning for backtest data.

CREATE TABLE IF NOT EXISTS backtest_candles (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument    TEXT        NOT NULL,
  timeframe     TEXT        NOT NULL,   -- 'H1' or 'M15'
  time          TIMESTAMPTZ NOT NULL,
  open          NUMERIC(12,6) NOT NULL,
  high          NUMERIC(12,6) NOT NULL,
  low           NUMERIC(12,6) NOT NULL,
  close         NUMERIC(12,6) NOT NULL,
  volume        INTEGER,
  complete      BOOLEAN DEFAULT TRUE,
  source        TEXT DEFAULT 'OANDA',
  created_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (instrument, timeframe, time)
);

-- Indexes for fast backtest queries
CREATE INDEX IF NOT EXISTS idx_bt_instrument_tf_time
  ON backtest_candles (instrument, timeframe, time DESC);

CREATE INDEX IF NOT EXISTS idx_bt_timeframe_time
  ON backtest_candles (timeframe, time DESC);

CREATE INDEX IF NOT EXISTS idx_bt_time
  ON backtest_candles (time DESC);

-- Enable Row Level Security (read-only for authenticated users)
ALTER TABLE backtest_candles ENABLE ROW LEVEL SECURITY;

-- Service role has full access (for backfill script)
CREATE POLICY "service_full_access" ON backtest_candles
  FOR ALL
  USING (TRUE)
  WITH CHECK (TRUE);

-- Authenticated users can read only
CREATE POLICY "auth_read_only" ON backtest_candles
  FOR SELECT
  TO authenticated
  USING (TRUE);

-- Add comment for documentation
COMMENT ON TABLE backtest_candles IS
  'Historical H1 and M15 OANDA candles for backtesting engine. Backfilled via src/backfill.js.';
