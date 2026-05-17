-- Email notification preferences per user
CREATE TABLE IF NOT EXISTS email_preferences (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_alerts  BOOLEAN NOT NULL DEFAULT true,
  daily_digest   BOOLEAN NOT NULL DEFAULT true,
  upgrade_prompts BOOLEAN NOT NULL DEFAULT true,
  unsubscribed   BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_email_prefs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_email_prefs_updated_at
  BEFORE UPDATE ON email_preferences
  FOR EACH ROW EXECUTE FUNCTION update_email_prefs_updated_at();

-- RLS: users can only read/write their own preferences
ALTER TABLE email_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_prefs_select ON email_preferences
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY email_prefs_upsert ON email_preferences
  FOR ALL USING (auth.uid() = user_id);
