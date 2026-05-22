-- Convert false_breakout_risk from BOOLEAN to NUMERIC(5,1) (0-100 score)
-- Previously stored true/false, now stores a continuous risk score

-- ── hourly_session_activity ─────────────────────────────────────────────────
ALTER TABLE hourly_session_activity
  ALTER COLUMN false_breakout_risk DROP DEFAULT,
  ALTER COLUMN false_breakout_risk TYPE NUMERIC(5,1) USING (CASE WHEN false_breakout_risk THEN 100.0 ELSE 0.0 END),
  ALTER COLUMN false_breakout_risk SET DEFAULT 0;

-- ── market_energy_sessions ──────────────────────────────────────────────────
ALTER TABLE market_energy_sessions
  ALTER COLUMN false_breakout_risk DROP DEFAULT,
  ALTER COLUMN false_breakout_risk TYPE NUMERIC(5,1) USING (CASE WHEN false_breakout_risk THEN 100.0 ELSE 0.0 END),
  ALTER COLUMN false_breakout_risk SET DEFAULT 0;
