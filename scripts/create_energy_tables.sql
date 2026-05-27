-- Energy Direction Engine — DB Tables
-- Run this in Supabase SQL Editor

-- ── 1. Currency state: confirmed direction per currency (8 rows max) ─────────
CREATE TABLE IF NOT EXISTS energy_currency_state (
  currency          TEXT PRIMARY KEY,
  direction         TEXT NOT NULL DEFAULT 'NEUTRAL',  -- STRONG / WEAK / NEUTRAL
  smooth_3h         NUMERIC,
  smooth_6h         NUMERIC,
  energy_at_trigger NUMERIC,
  trigger_session   TEXT,
  triggered_at      TIMESTAMPTZ,
  threshold_met     BOOLEAN DEFAULT false,
  active            BOOLEAN DEFAULT false,
  energy_event_type TEXT     -- NEW / CONTINUATION / REVERSAL
);

-- ── 2. Active signal pairs with phase monitoring ─────────────────────────────
CREATE TABLE IF NOT EXISTS energy_signal_pairs (
  instrument        TEXT PRIMARY KEY,
  dir               TEXT NOT NULL,         -- BUY / SELL
  strong_ccy        TEXT,
  weak_ccy          TEXT,
  phase             TEXT DEFAULT 'MONITORING',  -- MONITORING / PULLBACK / COMPRESSION / READY / ENTRY
  phase_changed_at  TIMESTAMPTZ,
  trigger_energy    NUMERIC,
  trigger_session   TEXT,
  triggered_at      TIMESTAMPTZ,
  v45               NUMERIC,
  v90               NUMERIC,
  spread_3h         NUMERIC,
  spread_6h         NUMERIC,
  de_combined       NUMERIC,
  impulse_score     NUMERIC,
  impulse_aligned   BOOLEAN,
  m15_state         TEXT,
  new_energy_event  BOOLEAN DEFAULT false,
  energy_event_type TEXT,                  -- NEW / CONTINUATION / REVERSAL
  energy_level      NUMERIC,
  active            BOOLEAN DEFAULT true,
  last_updated      TIMESTAMPTZ
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_esp_active ON energy_signal_pairs(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_ecs_active ON energy_currency_state(active) WHERE active = true;
