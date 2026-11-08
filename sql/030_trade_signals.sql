-- ============================================================================
-- NervaFX — Trade Signal & Performance module (research, UNVALIDATED).
-- Run in the Supabase SQL Editor. Idempotent (IF NOT EXISTS / ON CONFLICT).
--
-- Design notes:
--   * Signals are MODELLED research instructions, never real trades. Execution is
--     ESTIMATED (mid-price history only; no bid/ask stored) under a configurable
--     cost model. Nothing here places broker orders.
--   * The `signals` row is IMMUTABLE once published. Lifecycle changes are appended
--     to `signal_events`; the mutable outcome projection lives in `trade_outcomes`.
--   * Parameter changes create a NEW strategy_versions row; past signals keep the
--     version (and frozen params) they were published under.
-- ============================================================================

-- ── Versioned strategy configurations (immutable per version) ────────────────
-- NOTE: named `signal_strategy_versions` (not `strategy_versions`) because the m15-
-- intelligence subsystem already owns a differently-shaped `strategy_versions` table.
CREATE TABLE IF NOT EXISTS signal_strategy_versions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  strategy_key  TEXT        NOT NULL,            -- 'today' | 'week' | 'month'
  version       TEXT        NOT NULL,            -- e.g. 'tsf-1.0.0'
  params        JSONB       NOT NULL,            -- frozen parameter set
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy_key, version)
);

-- ── Ranking snapshot used for each evaluation decision ───────────────────────
CREATE TABLE IF NOT EXISTS signal_rankings (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  strategy_key    TEXT        NOT NULL,
  version         TEXT        NOT NULL,
  origin          TEXT        NOT NULL DEFAULT 'historical',  -- 'historical' | 'forward'
  info_cutoff_ms  BIGINT      NOT NULL,          -- entry-candle close used as the decision cutoff
  baseline_ms     BIGINT      NOT NULL,          -- period baseline (day/week/month start)
  ranks           JSONB       NOT NULL,          -- all 28: {pair,differential,bias,rank}
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy_key, version, info_cutoff_ms)
);
CREATE INDEX IF NOT EXISTS idx_sr_strat_cutoff
  ON signal_rankings (strategy_key, info_cutoff_ms DESC);

-- ── Immutable published signal record ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_key       TEXT        NOT NULL,
  version            TEXT        NOT NULL,
  origin             TEXT        NOT NULL DEFAULT 'historical',  -- 'historical' | 'forward'
  pair               TEXT        NOT NULL,
  direction          TEXT        NOT NULL,        -- 'BUY' | 'SELL'
  published_at_ms    BIGINT      NOT NULL,        -- = entry candle t close (publication is after t closes)
  info_cutoff_ms     BIGINT      NOT NULL,        -- data cutoff for the decision (= entry_close_ms)
  entry_close_ms     BIGINT      NOT NULL,        -- close time of trigger candle t (dedup key)
  rank               INTEGER     NOT NULL,        -- selection rank 1..3
  period_differential DOUBLE PRECISION NOT NULL,
  confirmation       JSONB       NOT NULL,        -- returns, breadth, candle refs, prev-candle context
  trigger            JSONB       NOT NULL,        -- t-2,t-1,t OHLC + closes-above refs
  atr                DOUBLE PRECISION NOT NULL,
  reference_entry    DOUBLE PRECISION NOT NULL,
  max_deviation      DOUBLE PRECISION NOT NULL,   -- 0.25 * signal-time ATR (price units)
  fixed_stop         DOUBLE PRECISION NOT NULL,
  indicative_target  DOUBLE PRECISION NOT NULL,
  entry_expiry_ms    BIGINT      NOT NULL,
  data_flags         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one signal per (strategy, version, pair, trigger candle) — prevents duplicates
  UNIQUE (strategy_key, version, pair, entry_close_ms)
);
CREATE INDEX IF NOT EXISTS idx_sig_strat_pub   ON signals (strategy_key, published_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sig_pair        ON signals (pair);
CREATE INDEX IF NOT EXISTS idx_sig_origin      ON signals (origin);

-- ── Append-only lifecycle events ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signal_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal_id   UUID        NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL,  -- PUBLISHED|ENTERED|STOP|TARGET|HOLD_EXIT|EXPIRED|CANCELLED|UNRESOLVED
  at_ms       BIGINT      NOT NULL,
  payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (signal_id, event_type, at_ms)
);
CREATE INDEX IF NOT EXISTS idx_se_signal ON signal_events (signal_id, at_ms);

-- ── Mutable outcome projection (one per signal) ──────────────────────────────
CREATE TABLE IF NOT EXISTS trade_outcomes (
  signal_id       UUID        PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
  strategy_key    TEXT        NOT NULL,
  status          TEXT        NOT NULL,   -- PUBLISHED|OPEN|CLOSED|EXPIRED|CANCELLED|UNRESOLVED
  modelled_fill   DOUBLE PRECISION,
  fill_ms         BIGINT,
  initial_stop    DOUBLE PRECISION,
  target          DOUBLE PRECISION,
  initial_risk    DOUBLE PRECISION,       -- |entry - stop| in price units (R)
  exit_price      DOUBLE PRECISION,
  exit_ms         BIGINT,
  exit_reason     TEXT,                   -- STOP|TARGET|HOLD_LIMIT|UNRESOLVED
  costs           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  net_pnl_acct    DOUBLE PRECISION,       -- account-currency P&L after costs (per modelled unit)
  net_r           DOUBLE PRECISION,       -- net P&L / initial risk, after costs
  ambiguity_flag  BOOLEAN     NOT NULL DEFAULT FALSE,
  data_quality    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_to_status ON trade_outcomes (strategy_key, status);
CREATE INDEX IF NOT EXISTS idx_to_exit   ON trade_outcomes (exit_ms);

-- ── Engine cursor (idempotent chronological advance per strategy) ─────────────
CREATE TABLE IF NOT EXISTS signal_engine_cursor (
  strategy_key                 TEXT        PRIMARY KEY,
  last_processed_entry_close_ms BIGINT     NOT NULL DEFAULT 0,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── RLS: service role full access; authenticated users read-only ─────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['signal_strategy_versions','signal_rankings','signals','signal_events','trade_outcomes','signal_engine_cursor']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$DROP POLICY IF EXISTS "service_full_access" ON %I$p$, t);
    EXECUTE format($p$CREATE POLICY "service_full_access" ON %I FOR ALL USING (TRUE) WITH CHECK (TRUE)$p$, t);
    EXECUTE format($p$DROP POLICY IF EXISTS "auth_read_only" ON %I$p$, t);
    EXECUTE format($p$CREATE POLICY "auth_read_only" ON %I FOR SELECT TO authenticated USING (TRUE)$p$, t);
  END LOOP;
END $$;

COMMENT ON TABLE signals IS
  'Immutable MODELLED trade-signal records (research, UNVALIDATED). Estimated execution; no broker orders.';
