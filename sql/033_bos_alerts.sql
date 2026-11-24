-- ============================================================================
-- NervaFX — Break-of-Structure (BoS) email alerts. Run in the Supabase SQL Editor. Idempotent.
--
-- Two tables, touched ONLY by the service role (the admin recipient API and the alert cron, both
-- using SUPABASE_SERVICE_KEY). RLS is enabled with no policies, so anon/authenticated clients get
-- nothing while the service role bypasses RLS as usual.
--
--   bos_alert_recipients — who receives the Inverted Flow "aligned pair + BoS" alerts.
--   bos_alert_log        — one row per (pair, direction) first seen on an EAT day, for de-duplication
--                          (a pair alerts once per EAT day, not on every 15-min cron tick).
--
-- Research/notification only — no orders, no buy/sell signal, no profitability claim.
-- ============================================================================

-- ── Recipients ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bos_alert_recipients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  label       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT                                   -- admin user id that added it (audit)
);

-- Case-insensitive uniqueness so the same address can't be added twice.
CREATE UNIQUE INDEX IF NOT EXISTS bos_alert_recipients_email_lower
  ON bos_alert_recipients (lower(email));

ALTER TABLE bos_alert_recipients ENABLE ROW LEVEL SECURITY;

-- ── De-duplication log ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bos_alert_log (
  id               BIGSERIAL PRIMARY KEY,
  pair             TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('up','down')),
  eat_date         DATE NOT NULL,                    -- Africa/Nairobi (EAT, UTC+3) calendar day
  strong           TEXT,
  weak             TEXT,
  spread           NUMERIC,
  recipient_count  INTEGER NOT NULL DEFAULT 0,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One alert per pair+direction per EAT day. The cron relies on this to avoid re-sending while a
-- BoS persists across ticks; a duplicate insert simply conflicts and is ignored.
CREATE UNIQUE INDEX IF NOT EXISTS bos_alert_log_unique_day
  ON bos_alert_log (pair, direction, eat_date);

CREATE INDEX IF NOT EXISTS bos_alert_log_eat_date ON bos_alert_log (eat_date);

ALTER TABLE bos_alert_log ENABLE ROW LEVEL SECURITY;
