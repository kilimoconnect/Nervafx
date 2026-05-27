-- migration_energy_journal.sql
-- Add energy_snapshot column to hourly_market_journal.
-- Stores the full energy direction state at journal write time:
--   peak_energy, total_pairs, strong/weak currencies,
--   phase_counts (ENTRY/READY/COMPRESSION/PULLBACK/MONITORING),
--   and per-pair details (instrument, dir, phase, energy_level, de_combined, etc.)

alter table hourly_market_journal
  add column if not exists energy_snapshot jsonb;
