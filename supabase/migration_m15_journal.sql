-- migration_m15_journal.sql
-- Add m15_impulses snapshot column to hourly_market_journal.
-- Stores the active M15 impulse moves (EXPANDING · all TFs aligned · ≥0.00100)
-- captured at the time of each journal write.

alter table hourly_market_journal
  add column if not exists m15_impulses jsonb;
