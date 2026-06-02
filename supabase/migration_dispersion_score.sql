-- Add dispersion_score column to hourly_session_activity
-- Currency Dispersion: (strongest − weakest currency) normalized 0-100
-- Large dispersion = currencies diverging = pairs trend
-- Small dispersion = currencies converging = pairs range

ALTER TABLE hourly_session_activity
  ADD COLUMN IF NOT EXISTS dispersion_score REAL DEFAULT 0;
