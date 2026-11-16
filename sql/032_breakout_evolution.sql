-- ============================================================================
-- NervaFX — Breakout methodology v2 (Evolution-based condition). ADDITIVE upgrade
-- of the v1 schema in 031. Run in the Supabase SQL Editor. Idempotent.
--
-- v2 derives currency direction from the zero-sum 1/8 Evolution index (recent-movement
-- condition over per-strategy fast/slow windows) instead of persistent break-of-structure
-- votes. The break-of-structure TRIGGER is unchanged. Only NEW columns are added; existing
-- v1 signal rows (version 'bss-_-1.0.0-t_') are left exactly as they are — never recomputed
-- or relabelled. v2 rows carry version 'bss-_-2.0.0-…' and so never collide with v1 on the
-- deterministic (strategy_key, version, pair, trigger_close_ms) key.
--
-- Signals only — no stops/targets/sizing/exits, no profitability or win-rate claims.
-- ============================================================================

-- ── breakout_signals: Evolution snapshot + spread inputs + market/processing times ───────────
ALTER TABLE breakout_signals ADD COLUMN IF NOT EXISTS condition_snapshot JSONB;   -- 8 currencies' Evolution condition at the trigger close
ALTER TABLE breakout_signals ADD COLUMN IF NOT EXISTS candidate_detail   JSONB;   -- spread-expansion inputs + base/quote class at the trigger close
ALTER TABLE breakout_signals ADD COLUMN IF NOT EXISTS evo_snapshot_ms    BIGINT;  -- M15 close used for the condition (= trigger close, coincident ordering)
ALTER TABLE breakout_signals ADD COLUMN IF NOT EXISTS market_close_ms    BIGINT;  -- market event time (trigger candle close)
ALTER TABLE breakout_signals ADD COLUMN IF NOT EXISTS processed_at_ms    BIGINT;  -- wall-clock when the cron/backfill published it

-- v1 derived integer vote scores; v2 stores signed-efficiency·100 (may be null). Relax NOT NULL
-- so a v2 insert with a null score (insufficient window) is still accepted.
ALTER TABLE breakout_signals ALTER COLUMN base_score  DROP NOT NULL;
ALTER TABLE breakout_signals ALTER COLUMN quote_score DROP NOT NULL;

-- ── breakout_decision_snapshots: carry the spread/breadth decision inputs ─────────────────────
ALTER TABLE breakout_decision_snapshots ADD COLUMN IF NOT EXISTS decision_inputs JSONB;

COMMENT ON COLUMN breakout_signals.condition_snapshot IS
  'Evolution-based currency condition (v2) for all 8 currencies at the trigger close: classification + period position + fast/slow movement, signed efficiency and breadth.';
COMMENT ON COLUMN breakout_signals.candidate_detail IS
  'v2 qualification inputs at the trigger close: directional index-spread expansion over both windows, base/quote classification.';
