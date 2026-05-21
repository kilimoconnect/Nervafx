-- Email alert deduplication log
-- Prevents the same alert type from being sent repeatedly within a cooldown window

CREATE TABLE IF NOT EXISTS email_alert_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_type  TEXT NOT NULL,          -- 'confluence', 'approved_trades', 'impulse'
  details     JSONB DEFAULT '{}',     -- extra context (pair list, counts, etc.)
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup by type + time
CREATE INDEX IF NOT EXISTS idx_email_alert_log_type_time
  ON email_alert_log (alert_type, sent_at DESC);

-- Auto-cleanup: drop rows older than 7 days (run via pg_cron or manual)
-- DELETE FROM email_alert_log WHERE sent_at < NOW() - INTERVAL '7 days';
