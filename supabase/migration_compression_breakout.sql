-- Compression Breakout + M15 Price Structure Entry
-- Two tables: compression baseline tracking + per-pair M15 structure watch

-- Compression baseline — single row tracking market compression state
CREATE TABLE IF NOT EXISTS compression_baseline (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  active              BOOLEAN DEFAULT FALSE,
  baseline_energy     REAL DEFAULT 100,
  baseline_locked     BOOLEAN DEFAULT FALSE,
  compression_start   TIMESTAMPTZ,
  lock_time           TIMESTAMPTZ,
  recovery_detected   BOOLEAN DEFAULT FALSE,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- M15 structure watch — per-pair price structure tracking
CREATE TABLE IF NOT EXISTS m15_structure_watch (
  instrument          TEXT PRIMARY KEY,
  direction           TEXT NOT NULL DEFAULT 'BUY',    -- BUY or SELL
  state               TEXT NOT NULL DEFAULT 'WATCHING', -- WATCHING, IMPULSE_DETECTED, PULLBACK_ACTIVE, STRUCTURE_FORMED, ENTRY_READY, INVALIDATED, INACTIVE
  impulse_high        REAL,
  impulse_low         REAL,
  pullback_high       REAL,
  pullback_low        REAL,
  entry_price         REAL,
  invalidation_price  REAL,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_m15_structure_state ON m15_structure_watch (state);
