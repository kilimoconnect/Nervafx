-- Direction Slots Migration
-- Adds 2-slot direction confirmation support with session-based expiry.
-- Run in Supabase SQL Editor.

-- ── 1. energy_currency_state: add slot + session tracking columns ──────────

ALTER TABLE energy_currency_state ADD COLUMN IF NOT EXISTS slot INTEGER NOT NULL DEFAULT 1;
ALTER TABLE energy_currency_state ADD COLUMN IF NOT EXISTS confirmed_session TEXT;
ALTER TABLE energy_currency_state ADD COLUMN IF NOT EXISTS confirmed_date TEXT;

-- Change PK from (currency) to (slot, currency)
ALTER TABLE energy_currency_state DROP CONSTRAINT IF EXISTS energy_currency_state_pkey;
ALTER TABLE energy_currency_state ADD PRIMARY KEY (slot, currency);

-- ── 2. energy_signal_pairs: add slot + entry eligibility columns ───────────

ALTER TABLE energy_signal_pairs ADD COLUMN IF NOT EXISTS slot INTEGER NOT NULL DEFAULT 1;
ALTER TABLE energy_signal_pairs ADD COLUMN IF NOT EXISTS entry_eligible_session TEXT;
ALTER TABLE energy_signal_pairs ADD COLUMN IF NOT EXISTS entry_eligible_date TEXT;

-- Change PK from (instrument) to (slot, instrument)
ALTER TABLE energy_signal_pairs DROP CONSTRAINT IF EXISTS energy_signal_pairs_pkey;
ALTER TABLE energy_signal_pairs ADD PRIMARY KEY (slot, instrument);

-- ── 3. Update indexes ─────────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_esp_active;
DROP INDEX IF EXISTS idx_ecs_active;
CREATE INDEX IF NOT EXISTS idx_esp_active ON energy_signal_pairs(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_ecs_active ON energy_currency_state(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_esp_slot ON energy_signal_pairs(slot);
CREATE INDEX IF NOT EXISTS idx_ecs_slot ON energy_currency_state(slot);
