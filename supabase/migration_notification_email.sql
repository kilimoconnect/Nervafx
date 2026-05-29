-- Add notification_email to email_preferences
-- Allows users to receive NervaFX alerts at a different email than their registered account email.
-- NULL = use registered email (default behavior).

ALTER TABLE email_preferences
  ADD COLUMN IF NOT EXISTS notification_email TEXT DEFAULT NULL;
