-- ============================================================================
-- NervaFX — Backtest results storage
-- Run this in the Supabase SQL Editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS backtest_results (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  date_from     TEXT NOT NULL,
  date_to       TEXT NOT NULL,
  instruments   INTEGER NOT NULL,
  bars_replayed INTEGER NOT NULL,
  total_trades  INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  win_rate      NUMERIC(5,1) DEFAULT 0,
  total_pips    INTEGER DEFAULT 0,
  profit_factor NUMERIC(6,2) DEFAULT 0,
  max_drawdown  INTEGER DEFAULT 0,
  avg_win       INTEGER DEFAULT 0,
  avg_loss      INTEGER DEFAULT 0,
  duration_sec  NUMERIC(8,1) DEFAULT 0,
  details       JSONB DEFAULT '{}'::JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bt_results_date ON backtest_results (run_date DESC);

ALTER TABLE backtest_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_full_access" ON backtest_results
  FOR ALL USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "auth_read_only" ON backtest_results
  FOR SELECT TO authenticated USING (TRUE);

COMMENT ON TABLE backtest_results IS
  'Stored results from backtest engine runs. Each row = one complete backtest.';
