-- Per-pair validation tracking for the Expansion → Validation → Entry system.
-- validation_started_at: when THIS pair entered its 2h validation window
--   (set on NEW pairs, REVERSAL restarts, and fresh events on REMOVED pairs).
-- trigger_ref: the energy_signal_pairs.triggered_at this watch cycle is based
--   on — used to detect a new energy event for the pair.

ALTER TABLE m15_structure_watch ADD COLUMN IF NOT EXISTS validation_started_at TIMESTAMPTZ;
ALTER TABLE m15_structure_watch ADD COLUMN IF NOT EXISTS trigger_ref TIMESTAMPTZ;
