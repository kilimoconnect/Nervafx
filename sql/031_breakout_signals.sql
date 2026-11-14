-- ============================================================================
-- NervaFX — Breakout Strength & Signals module (research, UNVALIDATED).
-- Run in the Supabase SQL Editor. Idempotent (IF NOT EXISTS / ON CONFLICT).
-- Purely ADDITIVE: creates only new `breakout_*` tables; touches nothing existing.
--
-- Methodology: latest qualifying higher-timeframe break of structure (per pair) →
-- currency strength (±1 base/quote votes) → strong-vs-weak pair qualification →
-- fresh lower-timeframe break → signal. Three independent strategies:
--   daily  : direction D1 , trigger H1
--   weekly : direction W1 , trigger H4
--   monthly: direction MN1, trigger D1
-- Candle boundaries are EAT (UTC+3, no DST), aggregated from stored H1.
--
-- Design notes:
--   * `breakout_signals` is IMMUTABLE once published (deterministic UUID dedup).
--     Signals only — NO stops/targets/sizing/exits, no profitability claim.
--   * Parameter (threshold) changes create a NEW breakout_settings_versions row;
--     past signals keep the version (and frozen params) they were published under.
--   * Replay is a deterministic as-of recompute and writes NOTHING to the live
--     tables; what-if replay runs are recorded in breakout_replay_runs only.
-- ============================================================================

-- ── Versioned threshold/params (immutable per version) ───────────────────────
CREATE TABLE IF NOT EXISTS breakout_settings_versions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  strategy_key  TEXT        NOT NULL,            -- 'daily' | 'weekly' | 'monthly'
  version       TEXT        NOT NULL,            -- methodology + threshold, e.g. 'bss-d-1.0.0-t5'
  params        JSONB       NOT NULL,            -- frozen: { strongThreshold: 4..7 }
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy_key, version)
);

-- ── Latest live higher-TF break per pair (mutable; upserted by the cron) ──────
CREATE TABLE IF NOT EXISTS breakout_pair_states (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timeframe       TEXT        NOT NULL,          -- 'D1' | 'W1' | 'MN1'
  pair            TEXT        NOT NULL,
  direction       SMALLINT    NOT NULL,          -- +1 bullish | -1 bearish | 0 unknown
  break_open_ms   BIGINT,
  break_close_ms  BIGINT,
  prev_high       DOUBLE PRECISION,
  prev_low        DOUBLE PRECISION,
  broken_boundary TEXT,                          -- 'high' | 'low' | null
  break_ohlc      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_evaluated_ms BIGINT    NOT NULL,          -- close of the last completed HTF candle seen
  reason          TEXT,                          -- when direction=0 (insufficient/no-break)
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (timeframe, pair)
);
CREATE INDEX IF NOT EXISTS idx_bps_tf ON breakout_pair_states (timeframe);

-- ── Immutable published signal record ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS breakout_signals (
  id                UUID        PRIMARY KEY,     -- deterministic uuid v5 of the dedup key
  strategy_key      TEXT        NOT NULL,
  version           TEXT        NOT NULL,
  origin            TEXT        NOT NULL DEFAULT 'historical',  -- 'forward' | 'historical'
  pair              TEXT        NOT NULL,
  direction         TEXT        NOT NULL,        -- 'BUY' | 'SELL'
  base_ccy          TEXT        NOT NULL,
  quote_ccy         TEXT        NOT NULL,
  dir_tf            TEXT        NOT NULL,         -- 'D1' | 'W1' | 'MN1'
  trigger_tf        TEXT        NOT NULL,         -- 'H1' | 'H4' | 'D1'
  trigger_open_ms   BIGINT      NOT NULL,
  trigger_close_ms  BIGINT      NOT NULL,        -- dedup key; the completed trigger candle
  broken_boundary   TEXT        NOT NULL,        -- 'high' | 'low'
  broken_level      DOUBLE PRECISION NOT NULL,   -- prior trigger candle's high/low that was broken
  reference_close   DOUBLE PRECISION NOT NULL,   -- trigger candle close (reference price, NOT a fill)
  base_score        SMALLINT    NOT NULL,
  quote_score       SMALLINT    NOT NULL,
  strength_snapshot JSONB       NOT NULL,        -- all 8 scores+classifications at the trigger close
  breakout_detail   JSONB       NOT NULL,        -- the HTF break that set the pair's direction
  trigger_detail    JSONB       NOT NULL,        -- trigger + prev candle OHLC
  published_at_ms   BIGINT      NOT NULL,        -- = trigger_close_ms (published after it closes)
  info_cutoff_ms    BIGINT      NOT NULL,        -- data cutoff for the decision (= trigger_close_ms)
  settings_version  TEXT        NOT NULL,
  data_flags        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one signal per (strategy, version, pair, trigger candle) — prevents duplicates
  UNIQUE (strategy_key, version, pair, trigger_close_ms)
);
CREATE INDEX IF NOT EXISTS idx_bsig_strat_pub ON breakout_signals (strategy_key, published_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_bsig_pair      ON breakout_signals (pair);
CREATE INDEX IF NOT EXISTS idx_bsig_origin    ON breakout_signals (origin);

-- ── All-28 decision snapshot per evaluation (audit / reproduce) ───────────────
CREATE TABLE IF NOT EXISTS breakout_decision_snapshots (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  strategy_key     TEXT        NOT NULL,
  version          TEXT        NOT NULL,
  origin           TEXT        NOT NULL DEFAULT 'forward',
  info_cutoff_ms   BIGINT      NOT NULL,         -- trigger-candle close used as the decision cutoff
  strength         JSONB       NOT NULL,         -- all 8 currencies: score/class/counts/contributions
  ranks            JSONB       NOT NULL,         -- all 28 pairs: qualification + reason
  settings_version TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy_key, version, info_cutoff_ms)
);
CREATE INDEX IF NOT EXISTS idx_bds_strat_cutoff
  ON breakout_decision_snapshots (strategy_key, info_cutoff_ms DESC);

-- ── Engine cursor (idempotent chronological advance per strategy) ─────────────
CREATE TABLE IF NOT EXISTS breakout_engine_cursor (
  strategy_key                   TEXT        PRIMARY KEY,
  last_processed_trigger_close_ms BIGINT     NOT NULL DEFAULT 0,
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Replay run audit (isolated; never touches live tables) ────────────────────
CREATE TABLE IF NOT EXISTS breakout_replay_runs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  config      JSONB       NOT NULL,              -- {strategy, fromMs, toMs, tz, mode, threshold}
  created_by  TEXT,                              -- user id (optional)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── RLS: service role full access; authenticated users read-only ─────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['breakout_settings_versions','breakout_pair_states','breakout_signals','breakout_decision_snapshots','breakout_engine_cursor','breakout_replay_runs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$DROP POLICY IF EXISTS "service_full_access" ON %I$p$, t);
    EXECUTE format($p$CREATE POLICY "service_full_access" ON %I FOR ALL USING (TRUE) WITH CHECK (TRUE)$p$, t);
    EXECUTE format($p$DROP POLICY IF EXISTS "auth_read_only" ON %I$p$, t);
    EXECUTE format($p$CREATE POLICY "auth_read_only" ON %I FOR SELECT TO authenticated USING (TRUE)$p$, t);
  END LOOP;
END $$;

COMMENT ON TABLE breakout_signals IS
  'Immutable breakout-methodology signal records (research, UNVALIDATED). Signals only; no orders, stops, targets or profitability claims.';
