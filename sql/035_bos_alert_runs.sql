-- ============================================================================
-- NervaFX — BoS alert run-log (heartbeat). Run in the Supabase SQL Editor. Idempotent.
--
-- One row per runBosAlerts() invocation, written by the service role (the candle-sync cron and the
-- dedicated BoS cron). Makes the automatic server-side trigger OBSERVABLE: did it run, how often,
-- what did it find (candidates / fresh / recipients), and did it send. Without this, a skipped or
-- non-firing cron is invisible because the alert path only writes bos_alert_log on a successful send.
--
-- Query to confirm the trigger is alive, e.g.:
--   select ran_at, source, candidates, fresh, recipients, sent, reason
--   from bos_alert_runs order by ran_at desc limit 20;
--
-- RLS enabled with no policies — anon/authenticated get nothing; the service role bypasses RLS.
-- Research/notification only — no orders, no buy/sell signal, no profitability claim.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bos_alert_runs (
  id          BIGSERIAL PRIMARY KEY,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT NOT NULL DEFAULT 'unknown',   -- 'candle-sync' | 'dedicated-cron' | 'manual'
  available   BOOLEAN NOT NULL DEFAULT TRUE,      -- was the compare view computable this run
  candidates  INTEGER NOT NULL DEFAULT 0,         -- aligned + BoS pairs found
  fresh       INTEGER NOT NULL DEFAULT 0,         -- not already alerted today (EAT)
  recipients  INTEGER NOT NULL DEFAULT 0,         -- active recipients at send time
  sent        BOOLEAN NOT NULL DEFAULT FALSE,     -- email actually went out
  reason      TEXT                                -- why nothing sent, when applicable
);

CREATE INDEX IF NOT EXISTS bos_alert_runs_ran_at ON bos_alert_runs (ran_at DESC);

ALTER TABLE bos_alert_runs ENABLE ROW LEVEL SECURITY;
