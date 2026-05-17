-- Add liquidity score columns to market_energy_sessions
-- Liquidity score identifies sessions with genuine directional flow vs scattered noise.
-- Formula: breadthCoherence × eMagnitude × directionalPersistence

ALTER TABLE market_energy_sessions
  ADD COLUMN IF NOT EXISTS liquidity_score NUMERIC(5,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS liquidity_grade VARCHAR(10) DEFAULT 'DEAD';
