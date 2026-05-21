-- Market Energy V2: Institutional Calculation Model
-- Adds new engine columns per NervaFX_Market_Energy_Calculation_Model.pdf
--
-- New engines: Momentum, Volatility Quality, Directional Control,
--              Currency Leadership, Tradability, False Breakout Detection

-- ── hourly_session_activity ─────────────────────────────────────────────────

ALTER TABLE hourly_session_activity
  ADD COLUMN IF NOT EXISTS momentum_score          NUMERIC(6,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS momentum_type           VARCHAR(20)  DEFAULT 'STABLE',
  ADD COLUMN IF NOT EXISTS directional_control     NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS volatility_quality      NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS volatility_type         VARCHAR(20)  DEFAULT 'DEAD',
  ADD COLUMN IF NOT EXISTS chaos_score             NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency_leadership_gap NUMERIC(8,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tradability_score       NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS false_breakout_risk     BOOLEAN       DEFAULT FALSE;

-- ── market_energy_sessions ──────────────────────────────────────────────────

ALTER TABLE market_energy_sessions
  ADD COLUMN IF NOT EXISTS momentum_score          NUMERIC(6,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS directional_control     NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS volatility_quality      NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS volatility_type         VARCHAR(20)  DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS chaos_score             NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency_leadership_gap NUMERIC(8,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tradability_score       NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tradability_grade       VARCHAR(20)  DEFAULT 'AVOID',
  ADD COLUMN IF NOT EXISTS false_breakout_risk     BOOLEAN       DEFAULT FALSE;
